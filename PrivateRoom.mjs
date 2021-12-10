export class PrivateRoom {
    static async create({ mediasoupWorker, roomId, socket }) {
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

        const mediasoupRouter = await mediasoupWorker.createRouter({
            mediaCodecs,
        });

        return new PrivateRoom({ mediasoupRouter, roomId, socket });
    }

    constructor({ mediasoupRouter, roomId }) {
        this._roomId = roomId;

        this._socket = null;

        this._mediasoupRouter = mediasoupRouter;

        this._transports = [];

        this._producers = [];

        this._consumers = [];

        this._roomPeers = {};
    }

    // Setup socket events
    init(socket) {
        this._socket = socket;
        console.log("INSIDE INIT LOLOLOL", this._socket.id, this._roomId);

        this._socket.on("join-private-room", async ({ isAdmin }, callback) => {
            console.log("INSIDE JOIN PRIVATE ROOM");
            this._socket.join(this._roomId);

            // Not sure if this will be used
            this._roomPeers[this._socket.id] = {
                socket: this._socket,
                roomName: this._roomId,
                transports: [],
                producers: [],
                consumers: [],
                peerDetails: {
                    name: "",
                    isAdmin,
                },
            };

            const rtpCapabilities = this._mediasoupRouter.rtpCapabilities;

            callback({ rtpCapabilities });
        });

        this._socket.on(
            "createWebRtcTransport",
            async ({ consumer }, callback) => {
                this.createWebRtcTransport().then(
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
                        this.addTransport(transport, consumer);
                        // this._roomPeers[this._socket.id].transports.set(transport.id, transport);
                    },
                    (error) => {
                        console.log(error);
                    }
                );
            }
        );

        this._socket.on("transport-connect", ({ transportId, dtlsParameters }, callback) => {
            this.getTransport(this._socket.id).connect({ dtlsParameters });
            // const transports = this._roomPeers[this._socket.id].transports.get(transportId); // Coming soon
            callback();
        });

        this._socket.on(
            "transport-recv-connect",
            async ({ dtlsParameters, serverConsumerTransportId }) => {
                console.log(`DTLS PARAMS: ${dtlsParameters}`);
                const consumerTransport = this._transports.find(
                    (transportData) =>
                        transportData.consumer &&
                        transportData.transport.id == serverConsumerTransportId
                ).transport;
                // console.log('CONSUMER TRANSPORT', consumerTransport);
                await consumerTransport.connect({ dtlsParameters });
            }
        );

        this._socket.on(
            "transport-produce",
            async ({ kind, rtpParameters, appData }, callback) => {
                // call produce based on the prameters from the client
                const producer = await this.getTransport(
                    this._socket.id
                ).produce({
                    kind,
                    rtpParameters,
                });

                // add producer to the producers array
                const { roomName } = this._roomPeers[this._socket.id];

                console.log("ADDING PRODUCER");
                this.addProducer(producer, roomName);

                this.informConsumers(producer.id);

                console.log("Producer ID: ", producer.id, producer.kind);

                producer.on("transportclose", () => {
                    console.log("transport for this producer closed ");
                    producer.close();
                });

                // Send back to the client the Producer's id
                callback({
                    id: producer.id,
                    producersExist: this._producers.length > 1 ? true : false,
                });
            }
        );

        // Consumers
        this._socket.on("getProducers", (callback) => {
            const { roomName } = this._roomPeers[this._socket.id];

            let producerList = [];
            this._producers.forEach((producerData) => {
                if (
                    producerData.socketId !== socket.id &&
                    producerData.roomName === roomName
                ) {
                    producerList = [...producerList, producerData.producer.id];
                }
            });

            callback(producerList);
        });

        this._socket.on(
            "consume",
            async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
                try {
                    const { roomName } = this._roomPeers[socket.id];
                    // const router = rooms[roomName].router;
                    let consumerTransport = this._transports.find(
                        (transportData) =>
                            transportData.consumer &&
                            transportData?.transport?.id ==
                                serverConsumerTransportId
                    )?.transport;
                    // check if the router can consume the specified producer
                    if (
                        this._mediasoupRouter.canConsume({
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
                            this._socket.emit("producer-closed", {
                                consumerId: consumer.id,
                                remoteProducerId,
                            });
                            consumer.close();
                        });

                        consumer.on("producerpause", () => {
                            console.log("producer was paused hehehe");
                            this._socket.emit("consumer-paused", {
                                consumerId: consumer.id,
                            });
                        });

                        consumer.on("producerresume", () => {
                            console.log("producer was resumed hehehe");
                            this._socket.emit("consumer-resumed", {
                                consumerId: consumer.id,
                            });
                        });

                        this.addConsumer(consumer);

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
                        for (const socket in this._roomPeers) {
                            if (this._roomPeers[socket].peerDetails.isAdmin) {
                                adminSocket = this._roomPeers[socket].socket;
                            }
                        }
                        adminSocket.emit("new-consumer");
                        // console.log("HERE IS ADMIN SOCKET", adminSocket);

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

        this._socket.on("consumer-resume", async ({ serverConsumerId }) => {
            console.log("consumer resume", serverConsumerId);
            const { consumer } = this._consumers.find(
                (consumerData) => consumerData.consumer.id === serverConsumerId
            );
            await consumer.resume();
        });

        this._socket.on("pauseProducer", async ({ producerId }, callback) => {
            const producer = this._producers.find(
                (p) => p.producer.id === producerId
            ).producer;
            console.log("PAUSING PRODUCER", producer.id);
    
            if (!producer) {
                // handle error
            }
            await producer.pause();
            callback();
        });

        this._socket.on("resumeProducer", async ({ producerId }, callback) => {
            const producer = this._producers.find(
                (p) => p.producer.id === producerId
            ).producer;
            console.log("RESUMING PRODUCER", producer.id);
            if (!producer) {
                // handle error
            }
    
            await producer.resume();
            callback();
        });

        this._socket.on("closeProducer", async ({ producerId }, callback) => {
            const producer = this._producers.find(
                (p) => p.producer.id === producerId
            ).producer;
            if (!producer) {
                callback({ error: "Producer not found" });
            }
    
            producer.close();
    
            // Remove producer
            console.log("PRODUCERS BEFORE", this._producers.length);
            this._producers = this._producers.filter((p) => p.producer.id !== producerId);
            console.log("PRODUCERS AFTER", this._producers.length);
        });

        // Cleanup - coming
        // this._socket.on("leave-private-room", ({ roomName }) => {
        //     console.log(
        //         "user left private room - removing consumers, producers, transports"
        //     );
        //     // consumers = removeItems(consumers, socket.id, "consumer");
        //     // producers = removeItems(producers, socket.id, "producer");
        //     // transports = removeItems(transports, socket.id, "transport");
    
        //     // // const { roomName } = peers[socket.id]
        //     // delete peers[socket.id];
    
        //     // Will find admin socket somehow later
        //     // Below is temp (emit to entire room - which is only admin)
        //     // this._socket.to(roomName).emit('left-private-room')
        // });

    }

    async createWebRtcTransport() {
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
                let transport =
                    await this._mediasoupRouter.createWebRtcTransport(
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
    }

    informConsumers(producerId) {
        console.log(
            `informConsumers - just joined, id ${producerId} ${this._roomId}`
        );

        const peerSocket = Object.keys(this._roomPeers)
            .filter((peer) => !this._roomPeers[peer].peerDetails.isAdmin)
            .map((peer) => this._roomPeers[peer])[0]?.socket;

        if (peerSocket) {
            peerSocket.emit("new-producer", { producerId });
        }
    }

    addProducer(producer) {
        this._producers = [
            ...this._producers,
            { socketId: this._socket.id, producer, roomName: this._roomId },
        ];

        this._roomPeers[this._socket.id] = {
            ...this._roomPeers[this._socket.id],
            producers: [
                ...this._roomPeers[this._socket.id].producers,
                producer.id,
            ],
        };
    }

    addConsumer(consumer) {
        // add the consumer to the consumers list
        this._consumers = [
            ...this._consumers,
            { socketId: this._socket.id, consumer, roomName: this._roomId },
        ];

        // add the consumer id to the peers list
        this._roomPeers[this._socket.id] = {
            ...this._roomPeers[this._socket.id],
            consumers: [
                ...this._roomPeers[this._socket.id].consumers,
                consumer.id,
            ],
        };
    }

    getTransport(socketId) {
        const [producerTransport] = this._transports.filter(
            (transport) =>
                transport.socketId === socketId
        );
        return producerTransport.transport;
    }

    addTransport(transport, consumer) {
        console.log("addTransport()");

        this._transports = [
            ...this._transports,
            {
                socketId: this._socket.id,
                transport,
                roomName: this._roomId,
                consumer,
            },
        ];

        this._roomPeers[this._socket.id] = {
            ...this._roomPeers[this._socket.id],
            transports: [
                ...this._roomPeers[this._socket.id].transports,
                transport.id,
            ],
        };
        console.log("TOTAL TRANSPORTS", this._transports.length);
    }

    close() {
        this._mediasoupRouter.close();
    }
}
