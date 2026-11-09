'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');

function createBrowser({ port = 0, delay = 0, ignoreClose = false } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/json/version') res.end(JSON.stringify({ Browser: 'FakeChromium/1', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` }));
    else if (req.url === '/json/list') res.end(JSON.stringify([{ id: 'page', type: 'page' }]));
    else if (req.url === '/json/activate/page' || req.url === '/json/new?about:blank') res.end('{}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data);
    if (request.method === 'Browser.close' && !ignoreClose) {
      socket.send(JSON.stringify({ id: request.id, result: {} }));
      socket.close(); server.close();
    }
  }));
  return new Promise(resolve => setTimeout(() => server.listen(port, '127.0.0.1', () => resolve({ server, sockets, port: server.address().port,
    close: () => new Promise(done => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(done); }),
  })), delay));
}

if (require.main === module) {
  if (process.env.FAKE_BROWSER_FATAL) { console.error('FATAL fake browser sandbox failure'); process.exitCode = 1; }
  else createBrowser({ port: Number(process.argv.find(a => a.startsWith('--remote-debugging-port='))?.split('=')[1]),
    delay: Number(process.env.FAKE_BROWSER_DELAY || 0), ignoreClose: process.env.FAKE_BROWSER_IGNORE_CLOSE === '1',
  }).then(browser => { console.log(JSON.stringify({ pid: process.pid, port: browser.port })); });
}

module.exports = { createBrowser };
