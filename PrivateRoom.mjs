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

        const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

        return new PrivateRoom({ mediasoupRouter, roomId, socket })
    }

    constructor({ mediasoupRouter, roomId, socket }) {
        this._roomId = roomId;

        this._socket = socket;

        this._mediasoupRouter = mediasoupRouter;

        this._transports = [];

        this._producers = [];

        this._consumers = [];
    }
}
