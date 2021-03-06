/**
 * Connections
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Abstraction layer for multi-process SockJS connections.
 *
 * This file handles all the communications between the users'
 * browsers, the networking processes, and users.js in the
 * main process.
 *
 * @license MIT license
 */

'use strict';

const MINUTES = 60 * 1000;

const cluster = require('cluster');
const fs = require('fs');
const FS = require('../lib/fs');

if (cluster.isMaster) {
	cluster.setupMaster({
		exec: require('path').resolve(__dirname, 'sockets'),
	});

	/** @type {Map<number, cluster.Worker>} */
	const workers = exports.workers = new Map();

	const spawnWorker = exports.spawnWorker = function () {
		let worker = cluster.fork({PSPORT: Config.port, PSBINDADDR: Config.bindaddress || '0.0.0.0', PSNOSSL: Config.ssl ? 0 : 1});
		let id = worker.id;
		workers.set(id, worker);
		worker.on('message', data => {
			// console.log('master received: ' + data);
			switch (data.charAt(0)) {
			case '*': {
				// *socketid, ip, protocol
				// connect
				let nlPos = data.indexOf('\n');
				let nlPos2 = data.indexOf('\n', nlPos + 1);
				Users.socketConnect(worker, id, data.slice(1, nlPos), data.slice(nlPos + 1, nlPos2), data.slice(nlPos2 + 1));
				break;
			}

			case '!': {
				// !socketid
				// disconnect
				Users.socketDisconnect(worker, id, data.substr(1));
				break;
			}

			case '<': {
				// <socketid, message
				// message
				let nlPos = data.indexOf('\n');
				Users.socketReceive(worker, id, data.substr(1, nlPos - 1), data.substr(nlPos + 1));
				break;
			}

			default:
			// unhandled
			}
		});

		return worker;
	};

	cluster.on('exit', (worker, code, signal) => {
		if (code === null && signal !== null) {
			// Worker was killed by Sockets.killWorker or Sockets.killPid, probably.
			console.log(`Worker ${worker.id} was forcibly killed with status ${signal}.`);
			workers.delete(worker.id);
		} else if (code === 0 && signal === null) {
			// Happens when killing PS with ^C
			console.log(`Worker ${worker.id} died, but returned a successful exit code.`);
			workers.delete(worker.id);
		} else if (code > 0) {
			// Worker was killed abnormally, likely because of a crash.
			require('../lib/crashlogger')(new Error(`Worker ${worker.id} abruptly died with code ${code} and signal ${signal}`), "The main process");
			// Don't delete the worker so it can be inspected if need be.
		}

		if (worker.isConnected()) worker.disconnect();
		// FIXME: this is a bad hack to get around a race condition in
		// Connection#onDisconnect sending room deinit messages after already
		// having removed the sockets from their channels.
		// @ts-ignore
		worker.send = () => {};

		let count = 0;
		for (const connection of Users.connections.values()) {
			if (connection.worker === worker) {
				Users.socketDisconnect(worker, worker.id, connection.socketid);
				count++;
			}
		}
		console.log(`${count} connections were lost.`);

		// Attempt to recover.
		spawnWorker();
	});

	/**
	 * @param {number} [port]
	 * @param {string} [bindAddress]
	 * @param {number} [workerCount]
	 */
	exports.listen = function (port, bindAddress, workerCount) {
		if (port !== undefined && !isNaN(port)) {
			Config.port = port;
			Config.ssl = null;
		} else {
			port = Config.port;

			// Autoconfigure when running in cloud environments.
			try {
				const cloudenv = require('cloud-env');
				// @ts-ignore
				bindAddress = cloudenv.get('IP', bindAddress);
				// @ts-ignore
				port = cloudenv.get('PORT', port);
			} catch (e) {}
		}
		if (bindAddress !== undefined) {
			Config.bindaddress = bindAddress;
		}
		if (port !== undefined) {
			Config.port = port;
		}
		if (workerCount === undefined) {
			workerCount = (Config.workers !== undefined ? Config.workers : 1);
		}
		// @ts-ignore - remove when Config is typed
		for (let i = 0; i < workerCount; i++) {
			spawnWorker();
		}
	};

	/**
	 * @param {cluster.Worker} worker
	 */
	exports.killWorker = function (worker) {
		let count = 0;
		for (const connection of Users.connections.values()) {
			if (connection.worker === worker) {
				Users.socketDisconnect(worker, worker.id, connection.socketid);
				count++;
			}
		}
		console.log(`${count} connections were lost.`);

		try {
			worker.kill('SIGTERM');
		} catch (e) {}

		return count;
	};

	/**
	 * @param {number} pid
	 */
	exports.killPid = function (pid) {
		for (const worker of workers.values()) {
			if (pid === worker.process.pid) {
				// @ts-ignore
				return this.killWorker(worker);
			}
		}
		return false;
	};

	/**
	 * @param {cluster.Worker} worker
	 * @param {string} socketid
	 * @param {string} message
	 */
	exports.socketSend = function (worker, socketid, message) {
		worker.send(`>${socketid}\n${message}`);
	};

	/**
	 * @param {cluster.Worker} worker
	 * @param {string} socketid
	 */
	exports.socketDisconnect = function (worker, socketid) {
		worker.send(`!${socketid}`);
	};

	/**
	 * @param {string} channelid
	 * @param {string} message
	 */
	exports.channelBroadcast = function (channelid, message) {
		for (const worker of workers.values()) {
			worker.send(`#${channelid}\n${message}`);
		}
	};

	/**
	 * @param {cluster.Worker} worker
	 * @param {string} channelid
	 * @param {string} message
	 */
	exports.channelSend = function (worker, channelid, message) {
		worker.send(`#${channelid}\n${message}`);
	};

	/**
	 * @param {cluster.Worker} worker
	 * @param {string} channelid
	 * @param {string} socketid
	 */
	exports.channelAdd = function (worker, channelid, socketid) {
		worker.send(`+${channelid}\n${socketid}`);
	};

	/**
	 * @param {cluster.Worker} worker
	 * @param {string} channelid
	 * @param {string} socketid
	 */
	exports.channelRemove = function (worker, channelid, socketid) {
		worker.send(`-${channelid}\n${socketid}`);
	};

	/**
	 * @param {string} channelid
	 * @param {string} message
	 */
	exports.subchannelBroadcast = function (channelid, message) {
		for (const worker of workers.values()) {
			worker.send(`:${channelid}\n${message}`);
		}
	};

	/**
	 * @param {cluster.Worker} worker
	 * @param {string} channelid
	 * @param {number} subchannelid
	 * @param {string} socketid
	 */
	exports.subchannelMove = function (worker, channelid, subchannelid, socketid) {
		worker.send(`.${channelid}\n${subchannelid}\n${socketid}`);
	};

	/**
	 * @param {cluster.Worker} worker
	 * @param {string} query
	 */
	exports.eval = function (worker, query) {
		worker.send(`$${query}`);
	};
} else {
	// is worker
	// @ts-ignore This file doesn't exist on the repository, so Travis checks fail if this isn't ignored
	global.Config = require('../config/config');

	if (process.env.PSPORT) Config.port = +process.env.PSPORT;
	if (process.env.PSBINDADDR) Config.bindaddress = process.env.PSBINDADDR;
	if (process.env.PSNOSSL && parseInt(process.env.PSNOSSL)) Config.ssl = null;

	if (Config.ofe) {
		try {
			require.resolve('node-oom-heapdump');
		} catch (e) {
			if (e.code !== 'MODULE_NOT_FOUND') throw e; // should never happen
			throw new Error(
				'node-oom-heapdump is not installed, but it is a required dependency if Config.ofe is set to true! ' +
				'Run npm install node-oom-heapdump and restart the server.'
			);
		}

		// Create a heapdump if the process runs out of memory.
		// @ts-ignore
		require('node-oom-heapdump')({
			addTimestamp: true,
		});
	}

	// Static HTTP server

	// This handles the custom CSS and custom avatar features, and also
	// redirects yourserver:8001 to yourserver-8001.psim.us

	// It's optional if you don't need these features.

	global.Dnsbl = require('./dnsbl');

	if (Config.crashguard) {
		// graceful crash
		process.on('uncaughtException', err => {
			require('../lib/crashlogger')(err, `Socket process ${cluster.worker.id} (${process.pid})`);
		});
	}

	let app = require('http').createServer();
	/** @type {?import('https').Server} */
	let appssl = null;
	if (Config.ssl) {
		let key;
		try {
			key = require('path').resolve(__dirname, Config.ssl.options.key);
			if (!fs.statSync(key).isFile()) throw new Error();
			try {
				key = fs.readFileSync(key);
			} catch (e) {
				require('../lib/crashlogger')(new Error(`Failed to read the configured SSL private key PEM file:\n${e.stack}`), `Socket process ${cluster.worker.id} (${process.pid})`);
			}
		} catch (e) {
			console.warn('SSL private key config values will not support HTTPS server option values in the future. Please set it to use the absolute path of its PEM file.');
			key = Config.ssl.options.key;
		}

		let cert;
		try {
			cert = require('path').resolve(__dirname, Config.ssl.options.cert);
			if (!fs.statSync(cert).isFile()) throw new Error();
			try {
				cert = fs.readFileSync(cert);
			} catch (e) {
				require('../lib/crashlogger')(new Error(`Failed to read the configured SSL certificate PEM file:\n${e.stack}`), `Socket process ${cluster.worker.id} (${process.pid})`);
			}
		} catch (e) {
			console.warn('SSL certificate config values will not support HTTPS server option values in the future. Please set it to use the absolute path of its PEM file.');
			cert = Config.ssl.options.cert;
		}

		if (key && cert) {
			try {
				// In case there are additional SSL config settings besides the key and cert...
				appssl = require('https').createServer(Object.assign({}, Config.ssl.options, {key, cert}));
			} catch (e) {
				require('../lib/crashlogger')(`The SSL settings are misconfigured:\n${e.stack}`, `Socket process ${cluster.worker.id} (${process.pid})`);
			}
		}
	}

	// Static server
	try {
		if (Config.disablenodestatic) throw new Error("disablenodestatic");
		const StaticServer = require('node-static').Server;
		const roomidRegex = /^\/(?:[A-Za-z0-9][A-Za-z0-9-]*)\/?$/;
		const cssServer = new StaticServer('./config');
		const avatarServer = new StaticServer('./config/avatars');
		const staticServer = new StaticServer('./server/static');
		/**
		 * @param {import('http').IncomingMessage} req
		 * @param {import('http').ServerResponse} res
		 */
		const staticRequestHandler = (req, res) => {
			// console.log(`static rq: ${req.socket.remoteAddress}:${req.socket.remotePort} -> ${req.socket.localAddress}:${req.socket.localPort} - ${req.method} ${req.url} ${req.httpVersion} - ${req.rawHeaders.join('|')}`);
			req.resume();
			req.addListener('end', () => {
				if (Config.customhttpresponse &&
						Config.customhttpresponse(req, res)) {
					return;
				}

				let server = staticServer;
				if (req.url) {
					if (req.url === '/custom.css') {
						server = cssServer;
					} else if (req.url.startsWith('/avatars/')) {
						req.url = req.url.substr(8);
						server = avatarServer;
					} else if (roomidRegex.test(req.url)) {
						req.url = '/';
					}
				}

				server.serve(req, res, e => {
					// @ts-ignore
					if (e && e.status === 404) {
						staticServer.serveFile('404.html', 404, {}, req, res);
					}
				});
			});
		};

		app.on('request', staticRequestHandler);
		if (appssl) appssl.on('request', staticRequestHandler);
	} catch (e) {
		if (e.message === 'disablenodestatic') {
			console.log('node-static is disabled');
		} else {
			console.log('Could not start node-static - try `npm install` if you want to use it');
		}
	}

	// SockJS server

	// This is the main server that handles users connecting to our server
	// and doing things on our server.

	const sockjs = require('sockjs');
	const options = {
		sockjs_url: "//play.pokemonshowdown.com/js/lib/sockjs-1.1.1-nwjsfix.min.js",
		prefix: '/showdown',
		/**
		 * @param {string} severity
		 * @param {string} message
		 */
		log(severity, message) {
			if (severity === 'error') console.log(`ERROR: ${message}`);
		},
	};

	if (Config.wsdeflate) {
		try {
			// @ts-ignore
			const deflate = require('permessage-deflate').configure(Config.wsdeflate);
			// @ts-ignore
			options.faye_server_options = {extensions: [deflate]};
		} catch (e) {
			require('../lib/crashlogger')(new Error("Dependency permessage-deflate is not installed or is otherwise unaccessable. No message compression will take place until server restart."), "Sockets");
		}
	}

	const server = sockjs.createServer(options);
	/**
	 * socketid:Connection
	 * @type {Map<string, import('sockjs').Connection>}
	 */
	const sockets = new Map();
	/**
	 * channelid:socketid:Connection
	 * @type {Map<string, Map<string, import('sockjs').Connection>>}
	 */
	const channels = new Map();
	/**
	 * channelid:socketid:subchannelid
	 * @type {Map<string, Map<string, string>>}
	 */
	const subchannels = new Map();

	/** @type {WriteStream} */
	const logger = FS(`logs/sockets-${process.pid}`).createAppendStream();

	// Deal with phantom connections.
	const sweepSocketInterval = setInterval(() => {
		for (const socket of sockets.values()) {
			// @ts-ignore
			if (socket.protocol === 'xhr-streaming' && socket._session && socket._session.recv) {
				logger.write('Found a ghost connection with protocol xhr-streaming\n');
				// @ts-ignore
				socket._session.recv.didClose();
			}
		}
	}, 10 * MINUTES);

	process.on('message', data => {
		// console.log('worker received: ' + data);
		/** @type {import('sockjs').Connection | undefined?} */
		let socket = null;
		let socketid = '';
		/** @type {Map<string, import('sockjs').Connection> | undefined?} */
		let channel = null;
		let channelid = '';
		/** @type {Map<string, string> | undefined?} */
		let subchannel = null;
		let subchannelid = '';
		let nlLoc = -1;
		let message = '';

		switch (data.charAt(0)) {
		case '$': // $code
			eval(data.substr(1));
			break;

		case '!': // !socketid
			// destroy
			socketid = data.substr(1);
			socket = sockets.get(socketid);
			if (!socket) return;
			socket.destroy();
			sockets.delete(socketid);
			for (const [channelid, channel] of channels) {
				channel.delete(socketid);
				subchannel = subchannels.get(channelid);
				if (subchannel) subchannel.delete(socketid);
				if (!channel.size) {
					channels.delete(channelid);
					if (subchannel) subchannels.delete(channelid);
				}
			}
			break;

		case '>':
			// >socketid, message
			// message
			nlLoc = data.indexOf('\n');
			socketid = data.substr(1, nlLoc - 1);
			socket = sockets.get(socketid);
			if (!socket) return;
			message = data.substr(nlLoc + 1);
			socket.write(message);
			break;

		case '#':
			// #channelid, message
			// message to channel
			nlLoc = data.indexOf('\n');
			channelid = data.substr(1, nlLoc - 1);
			channel = channels.get(channelid);
			if (!channel) return;
			message = data.substr(nlLoc + 1);
			for (const socket of channel.values()) socket.write(message);
			break;

		case '+':
			// +channelid, socketid
			// add to channel
			nlLoc = data.indexOf('\n');
			socketid = data.substr(nlLoc + 1);
			socket = sockets.get(socketid);
			if (!socket) return;
			channelid = data.substr(1, nlLoc - 1);
			channel = channels.get(channelid);
			if (!channel) {
				channel = new Map();
				channels.set(channelid, channel);
			}
			channel.set(socketid, socket);
			break;

		case '-':
			// -channelid, socketid
			// remove from channel
			nlLoc = data.indexOf('\n');
			channelid = data.slice(1, nlLoc);
			channel = channels.get(channelid);
			if (!channel) return;
			socketid = data.slice(nlLoc + 1);
			channel.delete(socketid);
			subchannel = subchannels.get(channelid);
			if (subchannel) subchannel.delete(socketid);
			if (!channel.size) {
				channels.delete(channelid);
				if (subchannel) subchannels.delete(channelid);
			}
			break;

		case '.':
			// .channelid, subchannelid, socketid
			// move subchannel
			nlLoc = data.indexOf('\n');
			channelid = data.slice(1, nlLoc);
			let nlLoc2 = data.indexOf('\n', nlLoc + 1);
			subchannelid = data.slice(nlLoc + 1, nlLoc2);
			socketid = data.slice(nlLoc2 + 1);

			subchannel = subchannels.get(channelid);
			if (!subchannel) {
				subchannel = new Map();
				subchannels.set(channelid, subchannel);
			}
			if (subchannelid === '0') {
				subchannel.delete(socketid);
			} else {
				subchannel.set(socketid, subchannelid);
			}
			break;

		case ':':
			// :channelid, message
			// message to subchannel
			nlLoc = data.indexOf('\n');
			channelid = data.slice(1, nlLoc);
			channel = channels.get(channelid);
			if (!channel) return;

			/** @type {[string?, string?, string?]} */
			let messages = [null, null, null];
			message = data.substr(nlLoc + 1);
			subchannel = subchannels.get(channelid);
			for (const [socketid, socket] of channel) {
				switch (subchannel ? subchannel.get(socketid) : '0') {
				case '1':
					if (!messages[1]) {
						messages[1] = message.replace(/\n\|split\n[^\n]*\n([^\n]*)\n[^\n]*\n[^\n]*/g, '\n$1').replace(/\n\n/g, '\n');
					}
					socket.write(messages[1]);
					break;
				case '2':
					if (!messages[2]) {
						messages[2] = message.replace(/\n\|split\n[^\n]*\n[^\n]*\n([^\n]*)\n[^\n]*/g, '\n$1').replace(/\n\n/g, '\n');
					}
					socket.write(messages[2]);
					break;
				default:
					if (!messages[0]) {
						messages[0] = message.replace(/\n\|split\n([^\n]*)\n[^\n]*\n[^\n]*\n[^\n]*/g, '\n$1').replace(/\n\n/g, '\n');
					}
					socket.write(messages[0]);
					break;
				}
			}
			break;
		}
	});

	// Clean up any remaining connections on disconnect. If this isn't done,
	// the process will not exit until any remaining connections have been destroyed.
	// Afterwards, the worker process will die on its own.
	process.once('disconnect', () => {
		clearInterval(sweepSocketInterval);

		for (const socket of sockets.values()) {
			try {
				socket.destroy();
			} catch (e) {}
		}
		sockets.clear();
		channels.clear();
		subchannels.clear();

		app.close();
		if (appssl) appssl.close();

		// Let the server(s) finish closing.
		setImmediate(() => process.exit(0));
	});

	// this is global so it can be hotpatched if necessary
	let isTrustedProxyIp = Dnsbl.checker(Config.proxyip);
	let socketCounter = 0;
	server.on('connection', socket => {
		// For reasons that are not entirely clear, SockJS sometimes triggers
		// this event with a null `socket` argument.
		if (!socket) return;

		if (!socket.remoteAddress) {
			// SockJS sometimes fails to be able to cache the IP, port, and
			// address from connection request headers.
			try {
				socket.destroy();
			} catch (e) {}
			return;
		}

		let socketid = '' + (++socketCounter);
		sockets.set(socketid, socket);

		let socketip = socket.remoteAddress;
		if (isTrustedProxyIp(socketip)) {
			let ips = (socket.headers['x-forwarded-for'] || '')
				.split(',')
				.reverse();
			for (let ip of ips) {
				let proxy = ip.trim();
				if (!isTrustedProxyIp(proxy)) {
					socketip = proxy;
					break;
				}
			}
		}

		// xhr-streamming connections sometimes end up becoming ghost
		// connections. Since it already has keepalive set, we set a timeout
		// instead and close the connection if it has been inactive for the
		// configured SockJS heartbeat interval plus an extra second to account
		// for any delay in receiving the SockJS heartbeat packet.
		if (socket.protocol === 'xhr-streaming') {
			// @ts-ignore
			socket._session.recv.thingy.setTimeout(
				// @ts-ignore
				socket._session.recv.options.heartbeat_delay + 1000,
				() => {
					try {
						socket.close();
					} catch (e) {}
				}
			);
		}

		// @ts-ignore
		process.send(`*${socketid}\n${socketip}\n${socket.protocol}`);

		socket.on('data', message => {
			// drop empty messages (DDoS?)
			if (!message) return;
			// drop messages over 100KB
			if (message.length > (100 * 1024)) {
				console.log(`Dropping client message ${message.length / 1024} KB...`);
				console.log(message.slice(0, 160));
				return;
			}
			// drop legacy JSON messages
			if (typeof message !== 'string' || message.startsWith('{')) return;
			// drop blank messages (DDoS?)
			let pipeIndex = message.indexOf('|');
			if (pipeIndex < 0 || pipeIndex === message.length - 1) return;

			// @ts-ignore
			process.send(`<${socketid}\n${message}`);
		});

		socket.once('close', () => {
			// @ts-ignore
			process.send(`!${socketid}`);
			sockets.delete(socketid);
			for (const channel of channels.values()) channel.delete(socketid);
		});
	});
	server.installHandlers(app, {});
	app.listen(Config.port, Config.bindaddress);
	console.log(`Worker ${cluster.worker.id} now listening on ${Config.bindaddress}:${Config.port}`);

	if (appssl) {
		// @ts-ignore
		server.installHandlers(appssl, {});
		appssl.listen(Config.ssl.port, Config.bindaddress);
		console.log(`Worker ${cluster.worker.id} now listening for SSL on port ${Config.ssl.port}`);
	}

	console.log(`Test your server at http://${Config.bindaddress === '0.0.0.0' ? 'localhost' : Config.bindaddress}:${Config.port}`);

	require('../lib/repl').start(`sockets-${cluster.worker.id}-${process.pid}`, cmd => eval(cmd));
}
