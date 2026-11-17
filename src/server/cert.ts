/**
 * @fileoverview TLS certificates for the WebTransport server.
 *
 * Browsers accept a self-signed certificate over WebTransport when the page
 * pins its SHA-256 hash (`serverCertificateHashes`). The certificate must be
 * ECDSA and valid for at most 14 days, so a fresh one is minted per start.
 * Deployments with a CA-issued certificate pass PEM files instead and need no
 * hash.
 */

import 'reflect-metadata';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import * as x509 from '@peculiar/x509';

/** PEM certificate and key, plus the pin hash for self-signed certs. */
export interface CertBundle {
  cert: string;
  key: string;
  /** Base64 SHA-256 of the DER certificate; empty for CA-issued certs. */
  hash: string;
  /** When the certificate stops being valid. */
  expires: Date;
}

/** Days a self-signed certificate is valid (browsers allow at most 14). */
const SELF_SIGNED_DAYS = 10;

/** Mints an ephemeral ECDSA P-256 certificate for `hosts`. */
export async function selfSigned(
  hosts: readonly string[],
): Promise<CertBundle> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
  const alg = {name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256'};
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const notBefore = new Date(Date.now() - 60_000);
  const expires = new Date(notBefore.getTime() + SELF_SIGNED_DAYS * 86_400_000);
  const names = hosts.map(h =>
    /^[\d.]+$|:/.test(h)
      ? {type: 'ip' as const, value: h}
      : {type: 'dns' as const, value: h},
  );
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Date.now().toString(16),
    name: 'CN=geodisk',
    notBefore,
    notAfter: expires,
    signingAlgorithm: alg,
    keys,
    extensions: [new x509.SubjectAlternativeNameExtension(names)],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return {
    cert: cert.toString('pem'),
    key: toPem(new Uint8Array(pkcs8), 'PRIVATE KEY'),
    hash: createHash('sha256')
      .update(new Uint8Array(cert.rawData))
      .digest('base64'),
    expires,
  };
}

/** Loads a CA-issued certificate and key from PEM files. */
export async function fromFiles(
  certFile: string,
  keyFile: string,
): Promise<CertBundle> {
  const [cert, key] = await Promise.all([
    readFile(certFile, 'utf8'),
    readFile(keyFile, 'utf8'),
  ]);
  const parsed = new x509.X509Certificate(cert);
  return {cert, key, hash: '', expires: parsed.notAfter};
}

function toPem(der: Uint8Array, label: string): string {
  const b64 = Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64.trim()}\n-----END ${label}-----\n`;
}
