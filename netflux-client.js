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

    var closeWebsocket = function (ctx, offline) {
        if (!ctx.ws) { return; }
        ctx.ws.onmessage = NOFUNC;
        ctx.ws.onopen = NOFUNC;
        ctx.ws.close();
        // If we manually close the websocket because of a connection loss, we can
        // instantly call the handlers to notify the user as fast as possible
        if (offline) {
            ctx.ws.onclose({ reason: "offline" });
            return;
        }
        setTimeoutX(ctx, function () {
            // onclose nulls this
            if (!ctx.ws) { return; }
            ctx.ws.onclose({ reason: "forced closed because websocket failed to close" });
        }, FORCE_CLOSE_TIMEOUT);
    };

    var send = function (ctx, content) {
        if (!ctx.ws) { return false; }
        ctx.ws.send(JSON.stringify(content));
        return true;
    };

    var networkSendTo = function networkSendTo(ctx, peerId, content) {
        var seq = ctx.seq++;
        var message = [seq, 'MSG', peerId, content];
        var sent = send(ctx, message);
        return new Promise(function (res, rej) {
            if (!sent) {
                return void rej({type: 'DISCONNECTED', message: JSON.stringify(message)});
            }
            ctx.requests[seq] = { reject: rej, resolve: res, time: now() };
        });
    };

    var channelBcast = function channelBcast(ctx, chanId, content) {
        var chan = ctx.channels[chanId];
        var seq = ctx.seq++;
        var message = [seq, 'MSG', chanId, content];
        if (!chan) {
            return new Promise(function (res, rej) {
                rej({type: 'NO_SUCH_CHANNEL', message: JSON.stringify(message)});
            });
        }
        var sent = send(ctx, message);
        return new Promise(function (res, rej) {
            if (!sent) {
                return void rej({type: 'DISCONNECTED', message: JSON.stringify(message)});
            }
            ctx.requests[seq] = { reject: rej, resolve: res, time: now(), chan: chan };
        });
    };

    var channelLeave = function channelLeave(ctx, chanId, reason) {
        var chan = ctx.channels[chanId];
        if (!chan) { return void console.debug('no such channel', chanId); }

        delete ctx.channels[chanId];
        if (!ctx.ws || ctx.ws.readyState !== 1) { return; } // the websocket connection is not opened

        var seq = ctx.seq++;
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

    var removeEventHandler = function (ctx, name, handler, mappings) {
        var handlers = mappings[name];
        if (!handlers) {
            throw new Error("no such event " + name);
        }
        var idx = handlers.indexOf(handler);
        if (idx === -1) { return; }
        handlers.splice(idx, 1);
    };

    var mkChannel = function mkChannel(ctx, id, priority) {
        if (ctx.channels[id]) {
            // If the channel exist, don't try to join it a second time
            return new Promise(function (res /*, rej */) {
                res(ctx.channels[id]);
            });
        }
        var q = ctx.queues.p2;
        if (priority === 1) { q = ctx.queues.p1; }
        else if (priority === 3) { q = ctx.queues.p3; }
        var internal = {
            queue: q,
            onMessage: [],
            onJoin: [],
            onLeave: [],
            members: [],
            jSeq: ctx.seq++
        };
        var mappings = { message: internal.onMessage, join: internal.onJoin, leave: internal.onLeave };
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
            on: makeEventHandlers(ctx, mappings),
            off: function (name, handler) { removeEventHandler(ctx, name, handler, mappings); }
        };
        ctx.requests[internal.jSeq] = chan;
        var message = [internal.jSeq, 'JOIN', id];
        var sent = send(ctx, message);

        return new Promise(function (res, rej) {
            if (!sent) {
                return void rej({type: 'DISCONNECTED', message: JSON.stringify(message)});
            }
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
        var mappings = { message: ctx.onMessage, disconnect: ctx.onDisconnect, reconnect: ctx.onReconnect };
        var network = {
            webChannels: ctx.channels,
            getLag: function _getLag() {
                return getLag(ctx);
            },
            sendto: function sendto(peerId, content) {
                return networkSendTo(ctx, peerId, content);
            },
            join: function join(chanId, priority) {
                return mkChannel(ctx, chanId, priority);
            },
            disconnect: function () {
                return disconnect(ctx);
            },
            on: makeEventHandlers(ctx, mappings),
            off: function (name, handler) { removeEventHandler(ctx, name, handler, mappings); }
        };
        network.__defineGetter__("webChannels", function () {
            return Object.keys(ctx.channels).map(function (k) {
                return ctx.channels[k];
            });
        });
        return network;
    };

    // The WebSocket implementation automatically queues incoming messages while they are handled
    // synchronously in our code. As long as  this queue is not empty, it will trigger the
    // "onmessage" event synchronously just after the previous message has been processed.
    // This means all our other operations are not executed until all the queued messages
    // went through. This is a problem especially for the PING system because it may delay
    // the "PING" sent to the server and then consider us offline when the timeOfLastPing is over
    // the limit.
    // The following code implements a custom queue. The WebSocket "onmessage" handler now only
    // pushes imcoming messages to our custom queue. Each message is then handled one at a time
    // asynchrnously using a setTimeout. With this code, the PING interval check can be executed
    // between two messages.
    var process = function (ctx) {
        //if (!Array.isArray(handlers)) { return; }
        if (ctx.queues.busy) { return; }
        var next = function () {
            var obj =   ctx.queues.p1.shift() ||
                        ctx.queues.p2.shift() ||
                        ctx.queues.p3.shift();
            if (!obj) {
                ctx.queues.busy = false;
                return;
            }
            ctx.queues.busy = true;
            var handlers = obj.h;
            var msg = obj.msg;
            handlers.forEach(function (h) {
                setTimeout(function () {
                    try {
                        h(msg[4], msg[1]);
                    } catch (e) {
                        console.error(e);
                    }
                });
            });
            //console.error(ctx.queues.p1.length, ctx.queues.p2.length, ctx.queues.p3.length);
            setTimeout(function () {
                next();
            });
        };
        //next(handlers.queue.shift());
        next();
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
                if (req.chan) {
                    // Make sure we preserve the order with the async onMessage for channels
                    var ackQ = req.chan._.queue;
                    ackQ.push({
                        msg: [],
                        h: [req.resolve]
                    });
                    process(ctx);
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
            var q = ctx.queues.p2;
            if (msg[3] === ctx.uid) {
                handlers = ctx.onMessage;
                if (typeof(msg[5]) === "number") {
                    if (msg[5] === 1) { q = ctx.queues.p1; }
                    if (msg[5] === 3) { q = ctx.queues.p3; }
                }
            } else {
                var chan = ctx.channels[msg[3]];
                if (!chan) {
                    console.log("message to non-existent chan " + JSON.stringify(msg));
                    return;
                }
                handlers = chan._.onMessage;
                q = chan._.queue;
            }
            q.push({
                msg: msg,
                h: handlers
            });
            //console.warn(ctx.queues.p1.length, ctx.queues.p2.length, ctx.queues.p3.length);
            /*handlers.queue = handlers.queue || [];
            handlers.queue.push(msg);*/
            process(ctx);
        }

        if (msg[2] === 'LEAVE') {
            var _chan = ctx.channels[msg[3]];
            if (!_chan) {
                if (msg[1] !== ctx.uid) {
                    console.log("leaving non-existent chan " + JSON.stringify(msg));
                }
                return;
            }
            var leaveIdx = _chan._.members.indexOf(msg[1]);
            if (leaveIdx !== -1) {
                _chan._.members.splice(leaveIdx, 1);
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
        makeWebsocket = makeWebsocket || function (url) { return new window.WebSocket(url); };
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

            queues: {
                p1: [],
                p2: [],
                p3: []
            },

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
                closeWebsocket(ctx, true);
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
            };
        };

        return new Promise(function (resolve, reject) {
            promiseResolve = resolve;
            promiseReject = reject;
            connectWs();
        });
    };

    return { connect: connect };
};

    if (typeof(module) !== 'undefined' && module.exports) {
        module.exports = factory();
    } else if ((typeof(define) !== 'undefined' && define !== null) && (define.amd !== null)) {
        define('netflux-client', [], factory);
    } else {
        window.netflux_websocket = factory();
    }
}());
