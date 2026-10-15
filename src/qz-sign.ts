import { createSign } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { generate } from 'selfsigned';

const dir = join(process.cwd(), 'qz');
const keyPath = join(dir, 'private-key.pem');
const certPath = join(dir, 'certificate.pem');

async function ensure() {
  if (existsSync(keyPath) && existsSync(certPath)) return;
  mkdirSync(dir, { recursive: true });
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const pems = await generate([{ name: 'commonName', value: 'HubPlay QZ' }], {
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'keyUsage', digitalSignature: true }],
  });
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
}

export async function qzCertificate() {
  await ensure();
  return readFileSync(certPath, 'utf8');
}

export async function qzSign(request: string) {
  await ensure();
  return createSign('SHA512').update(request).sign(readFileSync(keyPath, 'utf8'), 'base64');
}
