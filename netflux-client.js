/*global: WebSocket */
(function () {
    'use strict';
var factory = function () {


    // How much lag before we send a ping
    var MAX_LAG_BEFORE_PING = 15000;

    // How much of a lag we accept before we will drop the socket
    var MAX_LAG_BEFORE_DISCONNECT = 30000;

    // How often to ping the server
    var PING_CYCLE = 5000;

    // How long before we decide we could not make a websocket to the server.
    var REQUEST_TIMEOUT = 30000;

    // If we try to close the websocket but it fails to close,
    // how long before we discard the socket and start a new one.
    var FORCE_CLOSE_TIMEOUT = 10000;

    // If we are unable to connect to the server (don't get a connection),
    // this is how often we will retry to connect.
    var RECONNECT_LOOP_CYCLE = 7000;


    var NOFUNC = function () {};

    var now = function now() {
        return new Date().getTime();
    };

    var getLag = function (ctx) {
        if (!ctx.ws) { return null; }
        if (!ctx.pingOutstanding) { return ctx.lastObservedLag; }
        return Math.max(now() - ctx.timeOfLastPingSent, ctx.lastObservedLag);
    };

    var setTimeoutX = function (ctx, func, time) {
        ctx.timeouts.push(setTimeout(func, time));
    };

    var closeWebsocket = function (ctx) {
        if (!ctx.ws) { return; }
        ctx.ws.onmessage = NOFUNC;
        ctx.ws.onopen = NOFUNC;
        ctx.ws.close();
        setTimeoutX(ctx, function () {
            // onclose nulls this
            if (!ctx.ws) { return; }
            ctx.ws.onclose({ reason: "forced closed because websocket failed to close" });
        }, FORCE_CLOSE_TIMEOUT);
    };

    var send = function (ctx, content) {
        if (!ctx.ws) { throw new Error("Disconnected, you cannot send any message right now"); }
        ctx.ws.send(JSON.stringify(content));
    }

    var networkSendTo = function networkSendTo(ctx, peerId, content) {
        var seq = ctx.seq++;
        send(ctx, [seq, 'MSG', peerId, content]);
        return new Promise(function (res, rej) {
            ctx.requests[seq] = { reject: rej, resolve: res, time: now() };
        });
    };

    var channelBcast = function channelBcast(ctx, chanId, content) {
        var chan = ctx.channels[chanId];
        if (!chan) {
            throw new Error("no such channel " + chanId);
        }
        var seq = ctx.seq++;
        send(ctx, [seq, 'MSG', chanId, content]);
        return new Promise(function (res, rej) {
            ctx.requests[seq] = { reject: rej, resolve: res, time: now() };
        });
    };

    var channelLeave = function channelLeave(ctx, chanId, reason) {
        var chan = ctx.channels[chanId];
        if (!chan) {
            throw new Error("no such channel " + chanId);
        }
        var seq = ctx.seq++;
        delete ctx.channels[chanId];
        if (!ctx.ws || ctx.ws.readyState !== 1) { return; } // the websocket connection is not opened
        send(ctx, [seq, 'LEAVE', chanId, reason]);
        var emptyFunction = function() {};
        ctx.requests[seq] = { reject: emptyFunction, resolve: emptyFunction, time: now() };
    };

    var makeEventHandlers = function makeEventHandlers(ctx, mappings) {
        return function (name, handler) {
            var handlers = mappings[name];
            if (!handlers) {
                throw new Error("no such event " + name);
            }
            handlers.push(handler);
        };
    };

    var mkChannel = function mkChannel(ctx, id) {
        if (ctx.channels[id]) {
            // If the channel exist, don't try to join it a second time
            return new Promise(function (res, rej) {
                res(ctx.channels[id]);
            });
        }
        var internal = {
            onMessage: [],
            onJoin: [],
            onLeave: [],
            members: [],
            jSeq: ctx.seq++
        };
        var chan = {
            _: internal,
            time: now(),
            id: id,
            members: internal.members,
            bcast: function bcast(msg) {
                return channelBcast(ctx, chan.id, msg);
            },
            leave: function leave(reason) {
                return channelLeave(ctx, chan.id, reason);
            },
            on: makeEventHandlers(ctx, { message: internal.onMessage, join: internal.onJoin, leave: internal.onLeave })
        };
        ctx.requests[internal.jSeq] = chan;
        send(ctx, [internal.jSeq, 'JOIN', id]);

        return new Promise(function (res, rej) {
            chan._.resolve = res;
            chan._.reject = rej;
        });
    };

    var disconnect = function (ctx) {
        if (ctx.ws) {
            var onclose = ctx.ws.onclose;
            ctx.ws.onclose = NOFUNC;
            ctx.ws.close();
            // this reason string is matched in other code so don't change it.
            onclose({ reason: "network.disconnect() called" });
        }
        ctx.timeouts.forEach(clearTimeout);
        ctx.timeouts = [];
    };

    var mkNetwork = function mkNetwork(ctx) {
        var network = {
            webChannels: ctx.channels,
            getLag: function _getLag() {
                return getLag(ctx);
            },
            sendto: function sendto(peerId, content) {
                return networkSendTo(ctx, peerId, content);
            },
            join: function join(chanId) {
                return mkChannel(ctx, chanId);
            },
            disconnect: function () {
                return disconnect(ctx);
            },
            on: makeEventHandlers(ctx, { message: ctx.onMessage, disconnect: ctx.onDisconnect, reconnect: ctx.onReconnect })
        };
        network.__defineGetter__("webChannels", function () {
            return Object.keys(ctx.channels).map(function (k) {
                return ctx.channels[k];
            });
        });
        return network;
    };

    var onMessage = function onMessage(ctx, evt) {
        var msg = void 0;
        try {
            msg = JSON.parse(evt.data);
        } catch (e) {
            console.log(e.stack);return;
        }
        if (msg[0] !== 0) {
            var req = ctx.requests[msg[0]];
            if (!req) {
                console.log("error: " + JSON.stringify(msg));
                return;
            }
            delete ctx.requests[msg[0]];
            if (msg[1] === 'ACK') {
                if (req.ping) {
                    // ACK of a PING
                    ctx.lastObservedLag = now() - Number(req.ping);
                    ctx.timeOfLastPingReceived = now();
                    ctx.pingOutstanding--;
                    return;
                }
                req.resolve();
            } else if (msg[1] === 'JACK') {
                if (req._) {
                    // Channel join request...
                    if (!msg[2]) {
                        throw new Error("wrong type of ACK for channel join");
                    }
                    req.id = msg[2];
                    ctx.channels[req.id] = req;
                    return;
                }
                req.resolve();
            } else if (msg[1] === 'ERROR') {
                if (typeof req.reject === "function") {
                    req.reject({ type: msg[2], message: msg[3] });
                } else if (req._ && typeof req._.reject === "function") {
                    if (msg[2] === 'EJOINED' && !ctx.channels[msg[3]]) {
                        // The server still sees us in the channel but we're not.
                        // Add the channel to the list and wait for the JOIN messages.
                        // The Promise will be resolve in the 'JOIN' section.
                        req.id = msg[3];
                        ctx.channels[req.id] = req;
                        return;
                    }
                    req._.reject({ type: msg[2], message: msg[3] });
                } else {
                    console.error(msg);
                }
            } else {
                req.reject({ type: 'UNKNOWN', message: JSON.stringify(msg) });
            }
            return;
        }

        if (msg[2] === 'IDENT') {
            ctx.uid = msg[3];
            ctx.ws._onident();
            ctx.pingInterval = setInterval(function () {
                if (now() - ctx.timeOfLastPingReceived < MAX_LAG_BEFORE_PING) { return; }
                if (now() - ctx.timeOfLastPingReceived > MAX_LAG_BEFORE_DISCONNECT) {
                    closeWebsocket(ctx);
                }
                if (ctx.pingOutstanding) { return; }
                var seq = ctx.seq++;
                var currentDate = now();
                ctx.timeOfLastPingSent = currentDate;
                ctx.pingOutstanding++;
                ctx.requests[seq] = { time: currentDate, ping: currentDate };
                send(ctx, [seq, 'PING']);
            }, PING_CYCLE);

            return;
        } else if (!ctx.uid) {
            // extranious message, waiting for an ident.
            return;
        }
        if (msg[2] === 'PING') {
            msg[2] = 'PONG';
            send(ctx, msg);
            return;
        }

        if (msg[2] === 'MSG') {
            var handlers = void 0;
            if (msg[3] === ctx.uid) {
                handlers = ctx.onMessage;
            } else {
                var chan = ctx.channels[msg[3]];
                if (!chan) {
                    console.log("message to non-existent chan " + JSON.stringify(msg));
                    return;
                }
                handlers = chan._.onMessage;
            }
            handlers.forEach(function (h) {
                try {
                    h(msg[4], msg[1]);
                } catch (e) {
                    console.error(e);
                }
            });
        }

        if (msg[2] === 'LEAVE') {
            var _chan = ctx.channels[msg[3]];
            if (!_chan) {
                if (msg[1] !== ctx.uid) {
                    console.log("leaving non-existent chan " + JSON.stringify(msg));
                }
                return;
            }
            _chan._.onLeave.forEach(function (h) {
                try {
                    h(msg[1], msg[4]);
                } catch (e) {
                    console.log(e.stack);
                }
            });
        }

        if (msg[2] === 'JOIN') {
            var _chan2 = ctx.channels[msg[3]];
            if (!_chan2) {
                console.log("ERROR: join to non-existent chan " + JSON.stringify(msg));
                return;
            }
            if (_chan2._.members.indexOf(msg[1]) !== -1) { return; }
            // have we yet fully joined the chan?
            var synced = _chan2._.members.indexOf(ctx.uid) !== -1;
            _chan2._.members.push(msg[1]);
            if (!synced && msg[1] === ctx.uid) {
                // sync the channel join event
                _chan2.myID = ctx.uid;
                _chan2._.resolve(_chan2);
            }
            if (synced) {
                _chan2._.onJoin.forEach(function (h) {
                    try {
                        h(msg[1]);
                    } catch (e) {
                        console.log(e.stack);
                    }
                });
            }
        }
    };

    var connect = function connect(websocketURL, makeWebsocket) {
        makeWebsocket = makeWebsocket || function (url) { return new window.WebSocket(url) };
        var ctx = {
            ws: null,
            seq: 1,
            uid: null,
            network: null,
            channels: {},
            onMessage: [],
            onDisconnect: [],
            onReconnect: [],
            timeouts: [],
            requests: {},
            pingInterval: null,

            timeOfLastPingSent: -1,
            timeOfLastPingReceived: -1,
            lastObservedLag: 0,
            pingOutstanding: 0
        };
        ctx.network = mkNetwork(ctx);

        // For the returned promise, after the promise is resolved/rejected these will be NOFUNC'd.
        var promiseResolve = NOFUNC;
        var promiseReject = NOFUNC;

        if (typeof(window) !== 'undefined') {
            window.addEventListener("offline", function () {
                if (['localhost', '127.0.0.1', ''].indexOf(window.location.hostname) !== -1) {
                    // We can still access localhost, even offline
                    return;
                }
                closeWebsocket(ctx);
            });
        }

        var connectWs = function () {
            var ws = ctx.ws = makeWebsocket(websocketURL);
            ctx.timeOfLastPingSent = ctx.timeOfLastPingReceived = now();
            ws.onmessage = function (msg) { return onMessage(ctx, msg); };
            ws.onclose = function (evt) {
                ws.onclose = NOFUNC;
                clearInterval(ctx.pingInterval);
                ctx.timeouts.forEach(clearTimeout);
                ctx.ws = null;
                if (ctx.uid) {
                    ctx.uid = null;
                    ctx.onDisconnect.forEach(function (h) {
                        try {
                            h(evt.reason);
                        } catch (e) {
                            console.log(e.stack);
                        }
                    });
                }
                // If the "onclose" comes from a "disconnect" call, the following timeout will be cleared
                // in the disconnect function to make sure we won't reconnect.
                // If the following line is turned async, we need another way to detect intentional close
                setTimeoutX(ctx, connectWs, (ctx.uid) ? 0 : RECONNECT_LOOP_CYCLE);
            };
            ws.onopen = function () {
                setTimeoutX(ctx, function () {
                    if (ctx.uid) { return; }
                    promiseReject({ type: 'TIMEOUT', message: 'waited ' + REQUEST_TIMEOUT + 'ms' });
                    promiseResolve = promiseReject = NOFUNC;
                    closeWebsocket(ctx);
                }, REQUEST_TIMEOUT);
            };
            ctx.ws._onident = function () {
                // This is to use the time of IDENT minus the connect time to guess a ping reception
                ctx.timeOfLastPingReceived = now();
                ctx.lastObservedLag = now() - ctx.timeOfLastPingSent;

                if (promiseResolve !== NOFUNC) {
                    promiseResolve(ctx.network);
                    promiseResolve = promiseReject = NOFUNC;
                } else {
                    ctx.channels = {};
                    ctx.requests = {};
                    ctx.pingOutstanding = 0;
                    ctx.onReconnect.forEach(function (h) {
                       try {
                            h(ctx.uid);
                        } catch (e) {
                            console.log(e.stack);
                        }
                    });
                }
            }
        };

        return new Promise(function (resolve, reject) {
            promiseResolve = resolve;
            promiseReject = reject;
            connectWs();
        });
    };

    return { connect: connect };
};

    if (typeof(module) !== undefined && module.exports) {
        module.exports = factory();
    } else if ((typeof(define) !== 'undefined' && define !== null) && (define.amd !== null)) {
        define([
            '/bower_components/es6-promise/es6-promise.min.js',
        ], factory);
    } else {
        window.netflux_websocket = factory();
    }
}());
