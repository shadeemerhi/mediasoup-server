import express, { response } from "express";
const app = express();
import http from "http";
import mediasoup, { createWorker } from "mediasoup";

import fs from "fs";
import path from "path";

import { Server } from "socket.io";
import { PrivateRoom } from "./PrivateRoom2.mjs";

const httpServer = http.createServer(app);
httpServer.listen(4000, () => {
    console.log("LISTENING ON PORT 4000");
});

const io = new Server(httpServer, {
    cors: {},
});

const connections = io.of("/mediasoup");

// TEMP
let worker;
// let rooms = {};
let peers = {};
let transports = [];
let producers = [];
let consumers = [];

// Private rooms
const rooms = new Map();

// const mediasoupWorkers = []; // Coming soon

// TEMP - CREATING A SINGLE WORKER
const createRoomWorker = async () => {
    const worker = await mediasoup.createWorker({
        rtcMinPort: 10000,
        rtcMaxPort: 10100,
    });
    console.log("worker pid", worker.pid);

    worker.on("died", (error) => {
        console.error("mediasoup worker has died");
        setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
    });
    return worker;
};
// TEMP
const mediasoupWorker = await createRoomWorker();

const getOrCreateRoom = async (roomId) => {
    let room = rooms.get(roomId);

    if (!room) {
        // create room
        room = await PrivateRoom.create({ mediasoupWorker, roomId });

        rooms.set(roomId, room);
    }
    return room;
};

// Create room router
const createRoom = async (roomName, socketId) => {
    const mediaCodecs = [
        {
            kind: "audio",
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
        },
        {
            kind: "video",
            mimeType: "video/VP8",
            clockRate: 90000,
            parameters: {
                "x-google-start-bitrate": 1000,
            },
        },
    ];
    let router1;
    let peers = [];
    if (rooms[roomName]) {
        router1 = rooms[roomName].router;
        peers = rooms[roomName].peers || [];
    } else {
        // router1 = await worker.createRouter({ mediaCodecs });
        router1 = await mediasoupWorker.createRouter({ mediaCodecs });
    }

    console.log(`Router ID: ${router1.id}`, peers.length);

    rooms[roomName] = {
        router: router1,
        peers: [...peers, socketId],
    };

    return router1;
};

connections.on("connection", async (socket) => {
    const id = socket.handshake.query.id;
    socket.join(id);
    console.log("HERE IS SOCKET ID", id);

    socket.emit("connection-success", {
        socketId: socket.id,
    });

    // Public room events
    socket.on("join-public-room", ({ userId, roomName, isAdmin }) => {
        console.log("JOINING PUBLIC ROOM", roomName, userId);
        socket.join(roomName);

        // Emit to all users in the public room
        socket.to(roomName).emit("joined-public-room", { userId });
    });

    socket.on("leave-public-room", ({ userId, roomName }) => {
        console.log("LEAVING PUBLIC ROOM", roomName, userId);
        socket.leave(roomName);
        socket.to(roomName).emit("left-public-room", { userId });
    });

    socket.on('private-room-request', async ({ roomId, isAdmin }, callback) => {
        console.log("GETTING/CREATING PRIVATE ROOM", roomId);

        const room = await getOrCreateRoom(roomId);
        room.initSocketEvents(socket, isAdmin);

        callback({ roomId });
    });

    socket.on("disconnect", () => {
        console.log("peer disconnected");
    });
});

const initSocketEvents = (socket) => {
    socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
        const roomName = peers[socket.id].roomName;

        const router = rooms[roomName].router;

        createWebRtcTransport(router).then(
            (transport) => {
                callback({
                    params: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    },
                });

                // add transport to Peer's properties
                addTransport(transport, roomName, consumer);
            },
            (error) => {
                console.log(error);
            }
        );
    });

    socket.on("transport-connect", ({ dtlsParameters }, callback) => {
        console.log("DTLS PARAMS... ", { dtlsParameters });

        getTransport(socket.id).connect({ dtlsParameters });
        callback();
    });

    socket.on(
        "transport-produce",
        async ({ kind, rtpParameters, appData }, callback) => {
            const producer = await getTransport(socket.id).produce({
                kind,
                rtpParameters,
            });

            // add producer to the producers array
            const { roomName } = peers[socket.id];

            console.log("ADDING PTRODUCE");
            addProducer(producer, roomName);

            informConsumers(roomName, socket.id, producer.id);

            console.log("Producer ID: ", producer.id, producer.kind);

            producer.on("transportclose", () => {
                console.log("transport for this producer closed ");
                producer.close();
            });

            // Send back to the client the Producer's id
            callback({
                id: producer.id,
                producersExist: producers.length > 1 ? true : false,
            });
        }
    );

    socket.on(
        "transport-recv-connect",
        async ({ dtlsParameters, serverConsumerTransportId }) => {
            console.log(`DTLS PARAMS: ${dtlsParameters}`);
            const consumerTransport = transports.find(
                (transportData) =>
                    transportData.consumer &&
                    transportData.transport.id == serverConsumerTransportId
            ).transport;
            await consumerTransport.connect({ dtlsParameters });
        }
    );

    socket.on(
        "consume",
        async (
            { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
            callback
        ) => {
            try {
                const { roomName } = peers[socket.id];
                const router = rooms[roomName].router;
                let consumerTransport = transports.find(
                    (transportData) =>
                        transportData.consumer &&
                        transportData?.transport?.id ==
                            serverConsumerTransportId
                )?.transport;

                // check if the router can consume the specified producer
                if (
                    router.canConsume({
                        producerId: remoteProducerId,
                        rtpCapabilities,
                    })
                ) {
                    console.log("REMOTE PRODUCER ID", remoteProducerId);
                    // transport can now consume and return a consumer
                    const consumer = await consumerTransport.consume({
                        producerId: remoteProducerId,
                        rtpCapabilities,
                        paused: true,
                    });

                    consumer.on("transportclose", () => {
                        console.log("transport close from consumer");
                    });

                    consumer.on("producerclose", () => {
                        console.log(
                            "producer of consumer closed",
                            remoteProducerId
                        );
                        socket.emit("producer-closed", {
                            consumerId: consumer.id,
                            remoteProducerId,
                        });
                        consumer.close();
                    });

                    consumer.on("producerpause", () => {
                        console.log("producer was paused hehehe");
                        socket.emit("consumer-paused", {
                            consumerId: consumer.id,
                        });
                    });

                    consumer.on("producerresume", () => {
                        console.log("producer was resumed hehehe");
                        socket.emit("consumer-resumed", {
                            consumerId: consumer.id,
                        });
                    });

                    addConsumer(consumer, roomName);

                    // from the consumer extract the following params
                    // to send back to the Client
                    const params = {
                        id: consumer.id,
                        producerId: remoteProducerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                        serverConsumerId: consumer.id,
                        producerPaused: consumer.producerPaused,
                    };

                    let adminSocket;
                    for (const socket in peers) {
                        if (peers[socket].peerDetails.isAdmin) {
                            adminSocket = peers[socket].socket;
                        }
                    }
                    adminSocket.emit("new-consumer");
                    console.log("HERE IS ADMIN SOCKET", adminSocket);

                    // send the parameters to the client
                    callback({ params });
                }
            } catch (error) {
                console.log("CONSUME EVENT ERROR", error.message);
                callback({
                    params: {
                        error: error,
                    },
                });
            }
        }
    );

    socket.on("consumer-resume", async ({ serverConsumerId }) => {
        console.log("consumer resume", serverConsumerId);
        const { consumer } = consumers.find(
            (consumerData) => consumerData.consumer.id === serverConsumerId
        );
        await consumer.resume();
    });

    // New
    socket.on("pauseProducer", async ({ producerId }, callback) => {
        const producer = producers.find(
            (p) => p.producer.id === producerId
        ).producer;
        console.log("PAUSING PRODUCER", producer.id);

        if (!producer) {
            // handle error
        }
        await producer.pause();
        callback();
    });

    socket.on("resumeProducer", async ({ producerId }, callback) => {
        const producer = producers.find(
            (p) => p.producer.id === producerId
        ).producer;
        console.log("RESUMING PRODUCER", producer.id);
        if (!producer) {
            // handle error
        }

        await producer.resume();
        callback();
    });

    socket.on("closeProducer", async ({ producerId }, callback) => {
        const producer = producers.find(
            (p) => p.producer.id === producerId
        ).producer;
        if (!producer) {
            callback({ error: "Producer not found" });
        }

        producer.close();

        // Remove producer
        console.log("PRODUCERS BEFORE", producers, producers.length);
        producers = producers.filter((p) => p.producer.id !== producerId);
        console.log("PRODUCERS AFTER", producers, producers.length);
    });

    socket.on("leave-private-room", ({ roomName }) => {
        console.log(
            "user left private room - removing consumers, producers, transports"
        );
        consumers = removeItems(consumers, socket.id, "consumer");
        producers = removeItems(producers, socket.id, "producer");
        transports = removeItems(transports, socket.id, "transport");

        // const { roomName } = peers[socket.id]
        delete peers[socket.id];

        // Will find admin socket somehow later
        // Below is temp (emit to entire room - which is only admin)
        socket.to(roomName).emit("left-private-room");
    });

    socket.on("disconnect", () => {
        // do some cleanup
        console.log("peer disconnected");
        consumers = removeItems(consumers, socket.id, "consumer");
        producers = removeItems(producers, socket.id, "producer");
        transports = removeItems(transports, socket.id, "transport");

        // const { roomName } = peers[socket.id]
        delete peers[socket.id];

        // // remove socket from room
        // rooms[roomName] = {
        //   router: rooms[roomName].router,
        //   peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
        // }
    });

    socket.on("getProducers", (callback) => {
        //return all producer transports
        const { roomName } = peers[socket.id];

        let producerList = [];
        producers.forEach((producerData) => {
            if (
                producerData.socketId !== socket.id &&
                producerData.roomName === roomName
            ) {
                producerList = [...producerList, producerData.producer.id];
            }
        });

        // return the producer list back to the client
        callback(producerList);
    });

    // Resource management functions
    const getTransport = (socketId) => {
        const [producerTransport] = transports.filter(
            (transport) =>
                transport.socketId === socketId && !transport.consumer
        );
        console.log("AFTER GETTING TRANSPORT", transports.length);
        return producerTransport.transport;
    };
    const addTransport = (transport, roomName, consumer) => {
        console.log("ADDING TRANSPORT", consumer);

        transports = [
            ...transports,
            { socketId: socket.id, transport, roomName, consumer },
        ];

        peers[socket.id] = {
            ...peers[socket.id],
            transports: [...peers[socket.id].transports, transport.id],
        };
        console.log("TOTAL TRANSPORTS", transports.length);
    };

    const addProducer = (producer, roomName) => {
        producers = [...producers, { socketId: socket.id, producer, roomName }];
        console.log("INSIDE ADD PRODUCER", producers);

        peers[socket.id] = {
            ...peers[socket.id],
            producers: [...peers[socket.id].producers, producer.id],
        };
    };

    const addConsumer = (consumer, roomName) => {
        // add the consumer to the consumers list
        consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

        // add the consumer id to the peers list
        peers[socket.id] = {
            ...peers[socket.id],
            consumers: [...peers[socket.id].consumers, consumer.id],
        };
    };

    const informConsumers = (roomName, socketId, id) => {
        console.log(
            `informConsumers - just joined, id ${id} ${roomName}, ${socketId}`
        );

        const peerSocket = Object.keys(peers)
            .filter((peer) => !peers[peer].peerDetails.isAdmin)
            .map((peer) => peers[peer])[0]?.socket;

        if (peerSocket) {
            peerSocket.emit("new-producer", { producerId: id });
        }
    };

    const removeItems = (items, socketId, type) => {
        items.forEach((item) => {
            if (item.socketId === socket.id) {
                item[type].close();
            }
        });
        items = items.filter((item) => item.socketId !== socket.id);

        return items;
    };
};

const createWebRtcTransport = async (router) => {
    return new Promise(async (resolve, reject) => {
        try {
            // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
            const webRtcTransport_options = {
                listenIps: [
                    {
                        ip: "0.0.0.0", // replace with relevant IP address
                        ip: "10.0.0.135",
                        //   announcedIp: '10.0.0.135',
                        //   announcedIp: '127.0.0.1'
                    },
                ],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            };

            // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
            let transport = await router.createWebRtcTransport(
                webRtcTransport_options
            );
            console.log(`transport id: ${transport.id}`);

            transport.on("dtlsstatechange", (dtlsState) => {
                if (dtlsState === "closed") {
                    transport.close();
                }
            });

            // transport.on('close', () => {
            //   console.log('transport closed')
            // })

            resolve(transport);
        } catch (error) {
            reject(error);
        }
    });
};
