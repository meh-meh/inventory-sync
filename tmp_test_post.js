const http = require('http');
const data = JSON.stringify({ listingId: '4303887099', sku: 'ope' });

const options = {
  hostname: 'localhost',
  port: 3003,
  path: '/debug/etsy-test',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
};

const req = http.request(options, res => {
  console.log(`STATUS: ${res.statusCode}`);
  res.setEncoding('utf8');
  res.on('data', chunk => console.log('BODY:', chunk));
});

req.on('error', e => {
  console.error('problem with request:', e.message);
});

req.write(data);
req.end();
