var net = require('net');

module.exports = function (RED) {
    'use strict';

    function QsysCoreNode(n) {
        RED.nodes.createNode(this, n);
        let host = n.host;
        let port = n.port;
        let isRedundant = n.isRedundant === 'true';
        let redundantHost = n.redundantHost;
        let authentication = n.authentication === 'true';
        let username = this.credentials.username;
        let password = this.credentials.password;
        let logConnection = n.logConnection === 'true';
        let logCommunications = n.logCommunications === 'true';
        let noOp = null;
        let reconnectAttempts = 0;

        this.changeGroup = [
            { 'autoPoll': false, 'params': { 'Id': 'group 1', 'Rate': parseFloat(n.pollTime1) } },
            { 'autoPoll': false, 'params': { 'Id': 'group 2', 'Rate': parseFloat(n.pollTime2) } },
            { 'autoPoll': false, 'params': { 'Id': 'group 3', 'Rate': parseFloat(n.pollTime3) } },
            { 'autoPoll': false, 'params': { 'Id': 'group 4', 'Rate': parseFloat(n.pollTime4) } }
        ];

        const logWithTimestamp = (message) => {
            const timestamp = new Date().toISOString();
            this.log(`[${timestamp}] ${message}`);
        };

        const initializeSocket = (socket, host, port) => {
            socket.setKeepAlive(true, 10000); // Enable keep-alive with a 10-second idle interval
            socket.setTimeout(30000); // Set a 30-second timeout to detect inactivity
            socket.setMaxListeners(0);

            socket.on('timeout', () => {
                logWithTimestamp('socket timeout detected, destroying socket');
                socket.destroy(); // Destroy the socket on timeout
            });

            socket.on('error', (err) => {
                if (logConnection) {
                    this.error(err.toString());
                }
                if (isRedundant) {
                    reconnectToRedundantHost();
                } else {
                    reconnect();
                }
            });

            socket.on('end', () => {
                if (logConnection) {
                    logWithTimestamp('socket end');
                }
            });

            socket.on('close', () => {
                if (logConnection) {
                    logWithTimestamp('socket closed');
                }
                if (noOp != null) {
                    clearInterval(noOp);
                    noOp = null;
                }
                reconnect();
            });

            return socket;
        };

        const reconnect = () => {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Exponential backoff, max 30 seconds
            setTimeout(() => {
                logWithTimestamp(`Attempting to reconnect (attempt ${reconnectAttempts + 1})...`);
                this.socket = initializeSocket(net.connect(port, host), host, port);
                reconnectAttempts++;
            }, delay);
        };

        const reconnectToRedundantHost = () => {
            logWithTimestamp('Switching to redundant host...');
            this.socket.destroy();
            this.socket = initializeSocket(net.connect(port, redundantHost), redundantHost, port);
        };

        const encapsulate = (obj) => {
            return Buffer.concat([Buffer.from(JSON.stringify(obj)), Buffer.from([0x0])]);
        };

        this.sendToCore = (obj) => {
            if (logCommunications) {
                logWithTimestamp('tx: ' + JSON.stringify(obj));
            }

            if (this.socket !== null) {
                this.socket.write(encapsulate(obj));
            }
        };

        this.autoPoll = (index) => {
            if (!this.changeGroup[index].autoPoll) {
                this.changeGroup[index].autoPoll = true;
                this.sendToCore({
                    "jsonrpc": "2.0",
                    "id": 1234,
                    "method": "ChangeGroup.AutoPoll",
                    "params": this.changeGroup[index].params
                });
            }
        };

        this.socket = initializeSocket(net.connect(port, host), host, port);

        this.socket.on('connect', () => {
            if (logConnection) {
                logWithTimestamp('socket connected');
            }
            reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        });

        this.socket.on('data', (data) => {
            if (logCommunications) {
                logWithTimestamp('rx: ' + data.toString());
            }

            let rx = [];
            try {
                for (let i = 0; i < data.length; i++) {
                    if (data[i] == 0x0 && data.length != 0) {
                        let obj = JSON.parse((Buffer.from(rx)).toString());
                        if ('method' in obj) {
                            switch (obj.method) {
                                case 'EngineStatus':
                                    if (obj.params.State === 'Active') {
                                        this.emit('ready');
                                    } else if (isRedundant && obj.params.State === 'Standby') {
                                        reconnectToRedundantHost();
                                    }
                                    break;
                                case 'ChangeGroup.Poll':
                                    let changes = obj.params.Changes;
                                    if (changes.length !== 0) {
                                        for (let change of changes) {
                                            this.emit('rx', change);
                                        }
                                    }
                                    break;
                                default:
                                    break;
                            }
                        }
                        rx = [];
                    } else {
                        rx.push(data[i]);
                    }
                }
            } catch (err) {
                this.error(`Error processing data: ${err.message}`);
            }
        });

        this.socket.on('ready', () => {
            if (logConnection) {
                logWithTimestamp('socket ready');
            }

            if (authentication) {
                this.socket.write(encapsulate({
                    'jsonrpc': '2.0',
                    'method': 'Logon',
                    'params': {
                        'User': username,
                        'Password': password
                    }
                }));
            }

            noOp = setInterval(() => {
                this.socket.write(encapsulate({
                    'jsonrpc': '2.0',
                    'method': 'NoOp',
                    'params': {}
                }));
            }, 30000);
        });

        this.on('close', (removed, done) => {
            if (this.socket) {
                this.socket.removeAllListeners(); // Remove all listeners
                if (noOp != null) {
                    clearInterval(noOp); // Clear the NoOp interval
                    noOp = null;
                }
                if (removed) {
                    this.socket.destroy();
                } else {
                    this.socket.end();
                }
            }
            done();
        });
    }

    RED.nodes.registerType('qsys-core', QsysCoreNode, {
        credentials: {
            username: { type: 'text' },
            password: { type: 'password' }
        }
    });
};