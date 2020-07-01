const crypto = require('crypto');
const fs = require('fs');
const YAML = require('yaml');
const { spawn } = require('child_process');

const ALGORITHM = 'aes-128-gcm';
const REPLACEMENT_REGEXP = /\$\$RailsCredentials(\.[a-zA-Z_]+)+/g;
const DEFAULT_CREDENTIALS_PATH = 'config/credentials.yml.enc';
const DEFAULT_KEY_PATH = 'config/master.key';

let credentialsPromise = null;

async function fileExists(file) {
  try {
    await fs.promises.access(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function getPaths() {
  let environment = process.env.RAILS_ENV || 'development';

  let envPath = `config/credentials/${environment}.yml.enc`;

  if (await fileExists(envPath)) {
    return [`config/credentials/${environment}.key`, envPath];
  } else {
    return [DEFAULT_KEY_PATH, DEFAULT_CREDENTIALS_PATH];
  }
}

async function loadCredentials() {
  let [keyPath, credentialsPath] = await getPaths();

  let encryptedCredentials = await fs.promises.readFile(credentialsPath);

  let key;
  if (await fileExists(keyPath)) {
    key = await fs.promises.readFile(keyPath);
    key = key.toString('ascii');
  } else {
    key = process.env.RAILS_MASTER_KEY;
  }
  if (!key) throw new Error('Missing master key');
  key = Buffer.from(key, 'hex');

  let [encryptedData, iv, authTag] = encryptedCredentials.toString().split('--').map(v => Buffer.from(v, 'base64'));

  if (!authTag || authTag.length !== 16) throw new Error('Invalid message');

  let cipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  cipher.setAuthTag(authTag);
  cipher.setAAD(Buffer.alloc(0));
  cipher.setAutoPadding(false);

  let decryptedData = cipher.update(encryptedData);
  decryptedData = Buffer.concat([decryptedData, cipher.final()]);

  let message = await marshalLoad(decryptedData);

  return YAML.parse(message);
}

function returnOrLoadCredentials() {
  if (!credentialsPromise) {
    credentialsPromise = loadCredentials();
  }
  return credentialsPromise;
}

function marshalLoad(data) {
  return new Promise((resolve, reject) => {
    let child = spawn('ruby', ['-e', 'puts Marshal.load(ARGF.read)'], { stdio: ['pipe', 'pipe', process.stderr] });

    let dataBuffers = []
    child.stdout.on('data', function (data) {
      dataBuffers.push(data);
    });

    child.on('close', function (code, signal) {
      if (code === 0) {
        let message = Buffer.concat(dataBuffers).toString();

        resolve(message);
      } else if (signal !== null) {
        reject(new Error('Marshal load killed with signal ' + signal));
      } else {
        reject(new Error('Marshal load failed with code ' + code));
      }
    });

    child.on('error', reject);

    child.stdin.write(data);
    child.stdin.end();
  })
}

async function loader(source) {
  let callback = this.async();

  if (!REPLACEMENT_REGEXP.test(source)) {
    callback(null, source);
    return;
  }

  try {
    let credentials = await returnOrLoadCredentials();

    let newSource = source.replace(REPLACEMENT_REGEXP, match => {
      let path = match.split('.');
      let obj = credentials;
      for (let i = 1; i < path.length; i++) {
        obj = obj[path[i]];
      }
      return JSON.stringify(obj);
    });

    callback(null, newSource);
  } catch (error) {
    callback(error);
  }
}

module.exports = loader;
