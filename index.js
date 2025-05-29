const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const { Readable } = require('stream');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const Message = require('./models/Message');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const upload = multer();
app.use(cors());
app.use(express.json());

// === MongoDB + GridFS Setup ===
let gridfsBucket;

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

mongoose.connection.once('open', () => {
  console.log('✅ MongoDB connected');
  gridfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: 'uploads',
  });
});

// === Real-time Features ===
let onlineUsers = 0;
let lastSeen = {};
let messageReactions = {};
let typingUsers = {};

io.on('connection', (socket) => {
  onlineUsers++;
  console.log('🟢 A user connected. Total:', onlineUsers);
  io.emit('updateOnlineUsers', onlineUsers);

  socket.on('userConnected', (role) => {
    lastSeen[socket.id] = new Date().toLocaleTimeString();
    socket.broadcast.emit('userStatus', `${role} connected`);
    io.emit('lastSeen', lastSeen);
  });

  socket.on('sendMessage', (msg) => {
    try {
      // Create a message instance (without saving yet)
      const message = new Message({
        text: msg.text,
        sender: msg.sender,
        image: msg.image || null,
      });

      // Emit immediately to all clients for instant display
      io.emit('newMessage', message);

      // Save message asynchronously in the background
      message.save()
        .then((savedMessage) => {
          console.log('✅ Message saved:', savedMessage);

          // Optionally update clients with saved message _id etc.
          io.emit('updateMessage', savedMessage);
        })
        .catch((err) => {
          console.error('❌ Error saving message:', err);
        });

      // Send email asynchronously (if sender is "F")
      if (msg.sender === "F") {
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: 'pandaconnect7@gmail.com',
            pass: 'pvgitcnukcfuvhog', // App password
          },
        });

        const mailOptions = {
          from: 'pandaconnect7@gmail.com',
          to: ['subbuchoda0@gmail.com', 'subramanyamchoda50@gmail.com'],
          subject: 'Personal Email',
          text: msg.text,
        };

        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            console.error('❌ Error sending email:', error);
          } else {
            console.log('✅ Email sent:', info.response);
          }
        });
      }
    } catch (error) {
      console.error('❌ Unexpected error in sendMessage:', error);
    }
  });

  socket.on('messageRead', (messageId, userId) => {
    io.emit('readMessage', { messageId, userId });
    io.emit('seenMessage', { messageId, userId });
  });

  socket.on('typing', (userId) => {
    typingUsers[userId] = true;
    io.emit('typing', Object.keys(typingUsers));
  });

  socket.on('stopTyping', (userId) => {
    delete typingUsers[userId];
    if (Object.keys(typingUsers).length === 0) {
      io.emit('stopTyping');
    }
  });

  socket.on('messageReaction', (messageId, emoji) => {
    if (!messageReactions[messageId]) messageReactions[messageId] = [];
    messageReactions[messageId].push(emoji);
    io.emit('messageReaction', { messageId, emoji });
  });

  socket.on('userDisconnected', (role) => {
    socket.broadcast.emit('userStatus', `${role} disconnected`);
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    console.log('🔴 A user disconnected. Total:', onlineUsers);
    io.emit('updateOnlineUsers', onlineUsers);

    lastSeen[socket.id] = new Date().toLocaleTimeString();
    io.emit('lastSeen', lastSeen);
  });
});

// === Routes ===

// Fetch all messages
app.get('/messages', async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Delete a message
app.delete('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await Message.findByIdAndDelete(id);
    io.emit('deleteMessage', id);
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Upload file
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file || !gridfsBucket) {
    return res.status(400).json({ message: "No file uploaded or GridFS not initialized" });
  }

  const bufferStream = new Readable();
  bufferStream.push(req.file.buffer);
  bufferStream.push(null);

  const uploadStream = gridfsBucket.openUploadStream(req.file.originalname, {
    contentType: req.file.mimetype,
  });

  bufferStream.pipe(uploadStream);

  uploadStream.on('finish', () => {
    res.json({ message: "File uploaded", fileId: uploadStream.id });
  });

  uploadStream.on('error', (err) => {
    console.error(err);
    res.status(500).json({ message: "Error uploading file" });
  });
});

// Get all files
app.get('/files', async (req, res) => {
  try {
    const files = await gridfsBucket.find().toArray();
    res.json(files);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error fetching files" });
  }
});

// Download file
app.get('/files/:filename', async (req, res) => {
  try {
    const files = await gridfsBucket.find({ filename: req.params.filename }).toArray();
    if (!files.length) return res.status(404).json({ message: "File not found" });

    const file = files[0];
    res.set({
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
    });

    gridfsBucket.openDownloadStream(file._id).pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error fetching file" });
  }
});

// Delete file
app.delete('/files/:filename', async (req, res) => {
  try {
    const files = await gridfsBucket.find({ filename: req.params.filename }).toArray();
    if (!files.length) return res.status(404).json({ message: "File not found" });

    await gridfsBucket.delete(files[0]._id);
    res.json({ message: "File deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error deleting file" });
  }
});

// Default route
app.use((req, res) => {
  res.send("Welcome to the chat & file upload server");
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
