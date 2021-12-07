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
                        this.addTransport(transport, this._roomId, consumer);
                    },
                    (error) => {
                        console.log(error);
                    }
                );
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

    addTransport(transport, consumer) {
        console.log("addTransport()");

        this._transports = [
            ...this._transports,
            { socketId: this._socket.id, transport, roomName: this._roomId, consumer },
        ];

        this._roomPeers[this._socket.id] = {
            ...this._roomPeers[this._socket.id],
            transports: [...this._roomPeers[this._socket.id].transports, transport.id],
        };
        console.log("TOTAL TRANSPORTS", this._transports.length);
    }

    close() {
        this._mediasoupRouter.close();
    }
}
