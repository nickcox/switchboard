const { openSync, closeSync } = require('node:fs');
const { tryLock } = require('fs-native-extensions');

const fd = openSync(process.argv[2], 'a+', 0o600);
try {
  console.log(JSON.stringify({ locked: tryLock(fd) }));
} finally {
  closeSync(fd);
}
