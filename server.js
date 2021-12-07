import express, { response } from "express";
const app = express();
import http from "http";
import mediasoup, { createWorker } from "mediasoup";

import fs from "fs";
import path from "path";

import { Server } from "socket.io";
import { PrivateRoom } from "./PrivateRoom.mjs";

const httpServer = http.createServer(app);
httpServer.listen(4000, () => {
    console.log("LISTENING ON PORT 4000");
});

const io = new Server(httpServer, {
    cors: {},
});

const connections = io.of("/mediasoup");

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


const getOrCreateRoom = async (roomId, socket) => {
    let room = rooms.get(roomId);

    if (!room) {
        // create room
        room = await PrivateRoom.create({ mediasoupWorker, roomId, socket });

        rooms.set(roomId, room);
    }
    return room;
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

    // Private room events
    socket.on("create-private-room", async ({ roomId }, callback) => {
        console.log("CREATING PRIVATE ROOM", roomId);
        const room = await getOrCreateRoom(roomId, socket);

        room.init();

        callback({ roomId, socketId: room?._socket.id });
    });

    socket.on("disconnect", () => {
        console.log("peer disconnected");
    });
});
