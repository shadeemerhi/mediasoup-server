export class PrivateRoom {
    static async create({ mediasoupWorker, roomId }) {
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

        return new PrivateRoom({ mediasoupRouter, roomId });
    }

    constructor({ mediasoupRouter, roomId }) {
        this._roomId = roomId;

        this._socket = null;

        this._mediasoupRouter = mediasoupRouter;

        this._transports = [];

        this._producers = [];

        this._consumers = [];

        this._peers = {};
    }

    getRtpCapabilities() {
      return this._mediasoupRouter.rtpCapabilities;
    }

    initSocketEvents(socket) {
        socket.on("join-private-room", async ({ isAdmin }, callback) => {
            console.log("INSIDE JOIN PRIVATE ROOM", this._roomId);
            socket.join(this._roomId);

            // Not sure if this will be used
            this._peers[socket.id] = {
                socket: socket,
                roomName: this._roomId,
                transports: new Map(),
                producers: new Map(),
                consumers: [],
                peerDetails: {
                    name: "",
                    isAdmin,
                },
            };

            const rtpCapabilities = this._mediasoupRouter.rtpCapabilities;

            callback({ rtpCapabilities });
        });
        
        socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
            const roomName = this._peers[socket.id].roomName;

            // const router = rooms[roomName].router;

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
                    // this._transports.set(transport.id, transport);
                    // this._peers[socket.id].transports.set(transport.id, transport);
                    this._transports.push({ socketId: socket.id, transport });
                    console.log('TRANSPORT ADDED', this._peers[socket.id]);

                    // addTransport(transport, roomName, consumer);
                },
                (error) => {
                    console.log(error);
                }
            );
        });

        socket.on("transport-connect", async ({ transportId, dtlsParameters }, callback) => {
            console.log("DTLS PARAMS... ", { dtlsParameters });

            // const transport = this._transports.get(transportId);

            const { transport } = this._transports.find(item => item.transport.id === transportId);

            // const transport = this._peers[socket.id].transports.get(transportId);
            console.log('FUCK FUCK FUCK', transport);

            if (!transport) {
                // handle no transport found
            }

            // getTransport(socket.id).connect({ dtlsParameters });
            await transport.connect({ dtlsParameters });
            callback();
        });

        socket.on(
            "transport-produce",
            async ({ transportId, kind, rtpParameters, appData }, callback) => {

                // const producer = await getTransport(socket.id).produce({
                //     kind,
                //     rtpParameters,
                // });

                const { transport } = this._transports.find(item => item.transport.id === transportId);
                // const transport = this._transports.get(transportId);
                // const transport = this._peers[socket.id].transports.get(transportId);
                if (!transport) {
                    // Handle no transport found
                }

                const producer = await transport.produce({
                    kind,
                    rtpParameters
                });

                // add producer to the producers array
                const { roomName } = this._peers[socket.id];

                console.log("ADDING PTRODUCE");

                // this._peers[socket.id].producers.set(producer.id, producer);
                this._producers.push({ socketId: socket.id, producer });

                // addProducer(producer, roomName);

                // informConsumers(roomName, socket.id, producer.id);
                informConsumers(socket.id, producer.id);

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

        socket.on(
            "transport-recv-connect",
            async ({ dtlsParameters, transportId }) => {
                console.log(`DTLS PARAMS: ${dtlsParameters}`);
                // const consumerTransport = this._transports.find(
                //     (transportData) =>
                //         transportData.consumer &&
                //         transportData.transport.id == serverConsumerTransportId
                // ).transport;

                // const transport = this._transports.get(transportId);
                // const transport = this._peers[socket.id].transports.get(transportId);
                const { transport } = this._transports.find(item => item.transport.id === transportId);
                await transport.connect({ dtlsParameters });
                // await consumerTransport.connect({ dtlsParameters });
                
            }
        );

        socket.on(
            "consume",
            async (
                {
                    transportId,
                    rtpCapabilities,
                    remoteProducerId,
                    serverConsumerTransportId,
                },
                callback
            ) => {
                try {
                    const { roomName } = this._peers[socket.id];
                    // const router = rooms[roomName].router;
                    // let consumerTransport = this._transports.find(
                    //     (transportData) =>
                    //         transportData.consumer &&
                    //         transportData?.transport?.id ==
                    //             serverConsumerTransportId
                    // )?.transport;

                    // const transport = this._transports.get(transportId);
                    // const transport = this._peers[socket.id].transports.get(transportId);
                    const { transport } = this._transports.find(item => item.transport.id === transportId);

                    // check if the router can consume the specified producer
                    if (
                        this._mediasoupRouter.canConsume({
                            producerId: remoteProducerId,
                            rtpCapabilities,
                        })
                    ) {
                        console.log("REMOTE PRODUCER ID", remoteProducerId);
                        // transport can now consume and return a consumer
                        const consumer = await transport.consume({
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
                        for (const socket in this._peers) {
                            if (this._peers[socket].peerDetails.isAdmin) {
                                adminSocket = this._peers[socket].socket;
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
            const { consumer } = this._consumers.find(
                (consumerData) => consumerData.consumer.id === serverConsumerId
            );
            await consumer.resume();
        });

        // New
        socket.on("pauseProducer", async ({ producerId }, callback) => {
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

        socket.on("resumeProducer", async ({ producerId }, callback) => {
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

        socket.on("closeProducer", async ({ producerId }, callback) => {
            const producer = this._producers.find(
                (p) => p.producer.id === producerId
            ).producer;

            if (!producer) {
                callback({ error: "Producer not found" });
            }

            producer.close();

            // Remove producer
            console.log("PRODUCERS BEFORE", this._producers, this._producers.length);
            this._producers = this._producers.filter((p) => p.producer.id !== producerId);
            console.log("PRODUCERS AFTER", this._producers, this._producers.length);
        });

        socket.on("leave-private-room", ({ roomName }) => {
            console.log(
                "user left private room - removing consumers, producers, transports"
            );
            this._consumers = removeItems(this._consumers, socket.id, "consumer");
            this._producers = removeItems(this._producers, socket.id, "producer");
            this._transports = removeItems(this._transports, socket.id, "transport");

            // const { roomName } = peers[socket.id]
            delete this._peers[socket.id];

            // Will find admin socket somehow later
            // Below is temp (emit to entire room - which is only admin)
            socket.to(roomName).emit("left-private-room");
        });

        socket.on("disconnect", () => {
            // do some cleanup
            console.log("peer disconnected");
            this._consumers = removeItems(this._consumers, socket.id, "consumer");
            this._producers = removeItems(this._producers, socket.id, "producer");
            this._transports = removeItems(this._transports, socket.id, "transport");

            delete this._peers[socket.id];
        });

        socket.on("getProducers", (callback) => {
            //return all producer transports
            const { roomName } = this._peers[socket.id];

            let producerList = [];
            this._producers.forEach(item => {
                if (item.socketId !== socket.id) {
                    producerList.push(item.producer.id);
                }
            });

            // return the producer list back to the client
            callback(producerList);
        });

        const addConsumer = (consumer, roomName) => {
            // add the consumer to the consumers list
            this._consumers = [
                ...this._consumers,
                { socketId: socket.id, consumer, roomName },
            ];

            // add the consumer id to the peers list
            this._peers[socket.id] = {
                ...this._peers[socket.id],
                consumers: [...this._peers[socket.id].consumers, consumer.id],
            };
        };

        const informConsumers = (socketId, producerId) => {
            console.log(
                `informConsumers - just joined, id ${producerId} ${this._roomId}, ${socketId}`
            );

            const peerSocket = Object.keys(this._peers)
                .filter((peer) => !this._peers[peer].peerDetails.isAdmin)
                .map((peer) => this._peers[peer])[0]?.socket;

            if (peerSocket) {
                peerSocket.emit("new-producer", { producerId });
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
}
