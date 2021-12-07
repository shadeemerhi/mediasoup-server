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

    constructor({ mediasoupRouter, roomId, socket }) {
        this._roomId = roomId;

        this._socket = socket;

        this._mediasoupRouter = mediasoupRouter;

        this._transports = [];

        this._producers = [];

        this._consumers = [];

        this._roomPeers = {};
    }

    // Setup socket events
    init() {
        console.log("INSIDE INIT LOLOLOL");

        this._socket.on("join-private-room", async ({ isAdmin }, callback) => {
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
                    },
                    (error) => {
                        console.log(error);
                    }
                );
            }
        );

        this._socket.on("transport-connect", ({ dtlsParameters }, callback) => {
            this.getTransport(this._socket.id).connect({ dtlsParameters });
            callback();
        });

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
            peerSocket.emit("new-producer", { producerId: id });
        }
    }

    addProducer(producer) {
        this._producers = [...this._producers, { socketId: this._socket.id, producer, roomName: this._roomId }];

        this._roomPeers[this._socket.id] = {
            ...this._roomPeers[this._socket.id],
            producers: [...this._roomPeers[this._socket.id].producers, producer.id],
        };
    }

    getTransport(socketId) {
        const [producerTransport] = this._transports.filter(
            (transport) =>
                transport.socketId === socketId && !transport.consumer
        );
        console.log("HERE ARE TRANSPORTS", this._transports);
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
