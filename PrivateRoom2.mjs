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
        this._socket = socket;
        this._socket.on("join-private-room", async ({ isAdmin }, callback) => {
            console.log("INSIDE JOIN PRIVATE ROOM", this._roomId);
            this._socket.join(this._roomId);

            // Not sure if this will be used
            this._peers[this._socket.id] = {
                socket: this._socket,
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

        this._socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
            const roomName = this._peers[this._socket.id].roomName;

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
                    this._transports.push({ socketId: this._socket.id, transport });
                    console.log("TRANSPORT ADDED", this._peers[this._socket.id]);

                    // addTransport(transport, roomName, consumer);
                },
                (error) => {
                    console.log(error);
                }
            );
        });

        this._socket.on(
            "transport-connect",
            async ({ transportId, dtlsParameters }, callback) => {
                const { transport } = this._transports.find(
                    (item) => item.transport.id === transportId
                );
                console.log("FUCK FUCK FUCK", transport);

                if (!transport) {
                    // handle no transport found
                }

                await transport.connect({ dtlsParameters });
                callback();
            }
        );

        this._socket.on(
            "transport-produce",
            async ({ transportId, kind, rtpParameters, appData }, callback) => {
                const { transport } = this._transports.find(
                    (item) => item.transport.id === transportId
                );
                if (!transport) {
                    // Handle no transport found
                };
                const producer = await transport.produce({
                    kind,
                    rtpParameters,
                });

                this._producers.push({ socketId: this._socket.id, producer });

                informConsumers(this._socket.id, producer.id);

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

        this._socket.on(
            "consume",
            async (
                {
                    transportId,
                    rtpCapabilities,
                    remoteProducerId,
                },
                callback
            ) => {
                try {
                    const { transport } = this._transports.find(
                        (item) => item.transport.id === transportId
                    );

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

                        this._consumers.push({ socketId: this._socket.id, consumer });

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

        this._socket.on("consumer-resume", async ({ serverConsumerId }) => {
            console.log("consumer resume", serverConsumerId);
            const { consumer } = this._consumers.find(
                (item) => item.consumer.id === serverConsumerId
            );
            await consumer.resume();
        });

        // New
        this._socket.on("pauseProducer", async ({ producerId }, callback) => {
            const { producer } = this._producers.find(
                (item) => item.producer.id === producerId
            );
            console.log("PAUSING PRODUCER", producer.id);

            if (!producer) {
                // handle error
            }
            await producer.pause();
            callback();
        });

        this._socket.on("resumeProducer", async ({ producerId }, callback) => {
            const { producer } = this._producers.find(
                (p) => p.producer.id === producerId
            );
            console.log("RESUMING PRODUCER", producer.id);
            if (!producer) {
                // handle error
            }

            await producer.resume();
            callback();
        });

        this._socket.on("closeProducer", async ({ producerId }, callback) => {
            const { producer } = this._producers.find(
                (p) => p.producer.id === producerId
            );

            if (!producer) {
                callback({ error: "Producer not found" });
            }

            producer.close();

            // Remove producer
            console.log(
                "PRODUCERS BEFORE",
                this._producers,
                this._producers.length
            );
            this._producers = this._producers.filter(
                (item) => item.producer.id !== producerId
            );
            console.log(
                "PRODUCERS AFTER",
                this._producers,
                this._producers.length
            );
        });

        this._socket.on("leave-private-room", ({ roomName }) => {
            console.log(
                "user left private room - removing consumers, producers, transports"
            );
            this._consumers = removeItems(
                this._consumers,
                this._socket.id,
                "consumer"
            );
            this._producers = removeItems(
                this._producers,
                this._socket.id,
                "producer"
            );
            this._transports = removeItems(
                this._transports,
                this._socket.id,
                "transport"
            );

            delete this._peers[this._socket.id];

            // Will find admin socket somehow later
            // Below is temp (emit to entire room - which is only admin)
            this._socket.to(roomName).emit("left-private-room");
        });

        this._socket.on("disconnect", () => {
            // do some cleanup
            console.log("peer disconnected - private room");
            this._consumers = removeItems(
                this._consumers,
                socket.id,
                "consumer"
            );
            this._producers = removeItems(
                this._producers,
                socket.id,
                "producer"
            );
            this._transports = removeItems(
                this._transports,
                socket.id,
                "transport"
            );

            delete this._peers[this._socket.id];
        });

        this._socket.on("getProducers", (callback) => {
            let producerList = [];
            this._producers.forEach((item) => {
                if (item.socketId !== this._socket.id) {
                    producerList.push(item.producer.id);
                }
            });

            // return the producer list back to the client
            callback(producerList);
        });

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
            items = items.filter((item) => item.socketId !== this._socket.id);

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
