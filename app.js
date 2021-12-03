import express, { response } from "express";
const app = express();
import http from "http";
import mediasoup from "mediasoup";

import fs from "fs";
import path from "path";

import { Server } from "socket.io";

// SSL - Later
// const options = {
//   key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
//   cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8')
// };

app.get("/", (req, res) => {
    res.send({ message: "Hello from the Media Soup Server" });
});

const httpServer = http.createServer(app);
httpServer.listen(4000, () => {
    console.log("LISTENING ON PORT 4000");
});

const io = new Server(httpServer, {
    cors: {},
});

// Will look into using the name space later
const connections = io.of("/mediasoup");

let worker;
let rooms = {};
let peers = {};
let transports = [];
let producers = [];
let consumers = [];

let adminProducer;

const createWorker = async () => {
    worker = await mediasoup.createWorker({
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

worker = createWorker();

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

connections.on("connection", async (socket) => {
    // const id = socket.handshake.query.id;
    // socket.join(id);
    console.log("HERE IS SOCKET ID", socket.id);
    socket.emit("connection-success", {
        socketId: socket.id,
    });

    const removeItems = (items, socketId, type) => {
        items.forEach((item) => {
            if (item.socketId === socket.id) {
                item[type].close();
            }
        });
        items = items.filter((item) => item.socketId !== socket.id);

        return items;
    };

    socket.on("disconnect", () => {
        // do some cleanup
        console.log("peer disconnected");
        consumers = removeItems(consumers, socket.id, "consumer");
        producers = removeItems(producers, socket.id, "producer");
        transports = removeItems(transports, socket.id, "transport");

        // const { roomName } = peers[socket.id]
        // delete peers[socket.id]

        // // remove socket from room
        // rooms[roomName] = {
        //   router: rooms[roomName].router,
        //   peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
        // }
    });

    socket.on("joinRoom", async ({ roomName, isAdmin }, callback) => {
        console.log("JOIN ROOM EVENT", roomName);

        socket.join(roomName);
        // create Router if it does not exist
        // const router1 = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
        const router1 = await createRoom(roomName, socket.id);

        peers[socket.id] = {
            socket,
            roomName, // Name for the Router this Peer joined
            transports: [],
            producers: [],
            consumers: [],
            peerDetails: {
                name: "",
                isAdmin, // Is this Peer the Admin?
            },
        };

        // console.log(peers[socket.id]);

        // get Router RTP Capabilities
        const rtpCapabilities = router1.rtpCapabilities;

        // call callback from the client and send back the rtpCapabilities
        callback({ rtpCapabilities });
    });

    const createRoom = async (roomName, socketId) => {
        // worker.createRouter(options)
        // options = { mediaCodecs, appData }
        // mediaCodecs -> defined above
        // appData -> custom application data - we are not supplying any
        // none of the two are required
        let router1;
        let peers = [];
        if (rooms[roomName]) {
            router1 = rooms[roomName].router;
            peers = rooms[roomName].peers || [];
        } else {
            router1 = await worker.createRouter({ mediaCodecs });
        }

        console.log(`Router ID: ${router1.id}`, peers.length);

        rooms[roomName] = {
            router: router1,
            peers: [...peers, socketId],
        };

        return router1;
    };

    // Client emits a request to create server side Transport
    // We need to differentiate between the producer and consumer transports
    socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
        // get Room Name from Peer's properties
        const roomName = peers[socket.id].roomName;

        // get Router (Room) object this peer is in based on RoomName
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

    const informConsumers = (roomName, socketId, id) => {
        console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
        // A new producer just joined
        // let all consumers to consume this producer
        producers.forEach((producerData) => {
            if (
                producerData.socketId !== socketId &&
                producerData.roomName === roomName
            ) {
                const producerSocket = peers[producerData.socketId].socket;
                // use socket to send producer id to producer
                producerSocket.emit("new-producer", { producerId: id });
            }
        });
    };

    const getTransport = (socketId) => {
        const [producerTransport] = transports.filter(
            (transport) =>
                transport.socketId === socketId && !transport.consumer
        );
        console.log("AFTER GETTING TRANSPORT", transports.length);
        return producerTransport.transport;
    };

    // see client's socket.emit('transport-connect', ...)
    socket.on("transport-connect", ({ dtlsParameters }, callback) => {
        console.log("DTLS PARAMS... ", { dtlsParameters });

        getTransport(socket.id).connect({ dtlsParameters });
        callback();
    });

    // see client's socket.emit('transport-produce', ...)
    socket.on(
        "transport-produce",
        async ({ kind, rtpParameters, appData }, callback) => {
            // call produce based on the prameters from the client
            const producer = await getTransport(socket.id).produce({
                kind,
                rtpParameters,
            });
            adminProducer = producer;

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

    // see client's socket.emit('transport-recv-connect', ...)
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

    // New
    socket.on(
        "consumeHost",
        async ({ rtpCapabilities, transportId }, callback) => {
            try {
                const { roomName } = peers[socket.id];
                const router = rooms[roomName].router;
                const consumerTransport = transports.find(
                    (transportData) =>
                        transportData.consumer &&
                        transportData?.transport?.id == transportId
                )?.transport;

                console.log("HERE IS TRANSPORT ID", transportId);

                // Only one producer (admin)
                const producer = producers[0].producer;
                // console.log('HERE IS ADMIN PRODUCER', producer.kind, rtpCapabilities);

                if (
                    router.canConsume({
                        producerId: producer.id,
                        rtpCapabilities,
                    })
                ) {
                    const consumer = await consumerTransport.consume({
                        producerId: producer.id,
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
                        socket.emit("producer-closed", { remoteProducerId });

                        consumerTransport.close([]);
                        consumer.close();
                    });

                    addConsumer(consumer, roomName);

                    // from the consumer extract the following params
                    // to send back to the Client
                    const params = {
                        id: consumer.id,
                        // producerId: remoteProducerId,
                        producerId: producer.id,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                        serverConsumerId: consumer.id,
                    };

                    let adminSocket;
                    for (const socket in peers) {
                        if (peers[socket].peerDetails.isAdmin) {
                            adminSocket = peers[socket].socket;
                        }
                    }
                    console.log("HERE IS ADMIN SOCKET", adminSocket.id);
                    // adminSocket.emit("new-consumer");
                    connections.to(roomName).emit("new-consumer");

                    // send the parameters to the client
                    callback({ params });
                }
                console.log("THIS IS HAPPENING");
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
                        // socket.emit("producer-closed", { remoteProducerId });
                        consumer.close();
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
    socket.on('pauseProducer', async ({ producerId }) => {
        const producer = producers.find(p => p.producer.id === producerId).producer;
        console.log('PAUSING PRODUCER', producer.id);
        
        if (!producer) {
            // handle error
        }
        await producer.pause();
    });
    
    socket.on('resumeProducer', async ({ producerId }) => {
        const producer = producers.find(p => p.producer.id === producerId).producer;
        console.log('RESUMING PRODUCER', producer.id);
        if (!producer) {
            // handle error
        }

        await producer.resume();
    })
});

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
