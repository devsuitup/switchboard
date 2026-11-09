'use strict';

const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');

function request(port, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    let timer;
    const fail = error => { clearTimeout(timer); reject(error); };
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 500 }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) req.destroy(new Error('Browser response exceeds limit'));
        else chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) { fail(new Error(`Browser HTTP ${res.statusCode}`)); return; }
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch {
          if (route.startsWith('/json/activate/')) resolve({}); else fail(new Error('Invalid browser JSON response'));
        }
      });
    });
    timer = setTimeout(() => req.destroy(new Error('Browser request timed out')), 500);
    req.once('timeout', () => req.destroy(new Error('Browser request timed out')));
    req.once('error', fail); req.end();
  });
}

function free(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function closeBrowser(state, version) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(version.webSocketDebuggerUrl); } catch { reject(new Error('Invalid browser WebSocket URL')); return; }
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== state.port || url.username || url.password) {
      reject(new Error('Browser WebSocket must use the owned loopback port')); return;
    }
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Browser close timed out')); }, 500);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })), { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser close failed')); }, { once: true });
    socket.addEventListener('message', () => { clearTimeout(timer); socket.close(); resolve(); }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

module.exports = { request, portFree: free, allocatePort, closeBrowser };
