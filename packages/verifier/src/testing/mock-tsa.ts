// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// A local RFC 3161 TSA for tests and offline demos. Its CA is generated at start-up and trusted by nobody
// else, so its tokens prove nothing about real time. Never configure it in production.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { OID, toPem } from '../tsa.js';

export type MockTsaMode =
  | 'ok'
  | 'wrong-nonce'
  | 'no-nonce'
  | 'wrong-imprint'
  | 'bad-signature'
  | 'no-eku'
  | 'no-ess'
  | 'reject'
  | 'garbage'
  | 'http-500'
  | 'slow';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

const rdn = (cn: string) =>
  new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: '2.5.4.3',
        value: new asn1js.Utf8String({ value: cn }),
      }),
    ],
  });

const extension = (extnID: string, value: pkijs.BasicConstraints | pkijs.ExtKeyUsage) =>
  new pkijs.Extension({
    extnID,
    critical: true,
    extnValue: value.toSchema().toBER(false),
    parsedValue: value,
  });

const makeCert = async (o: {
  subject: string;
  issuer: string;
  publicKey: webcrypto.CryptoKey;
  signingKey: webcrypto.CryptoKey;
  serial: number;
  ca: boolean;
  timeStamping: boolean;
}) => {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: o.serial });
  cert.subject = rdn(o.subject);
  cert.issuer = rdn(o.issuer);
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = new Date(Date.now() + 365 * 86_400_000);
  cert.extensions = [extension(OID.basicConstraints, new pkijs.BasicConstraints({ cA: o.ca }))];
  if (o.timeStamping)
    cert.extensions.push(
      extension(OID.extKeyUsage, new pkijs.ExtKeyUsage({ keyPurposes: [OID.timeStamping] })),
    );
  await cert.subjectPublicKeyInfo.importKey(o.publicKey);
  await cert.sign(o.signingKey, 'SHA-256');
  return cert;
};

const keyPair = () =>
  webcrypto.subtle.generateKey(ECDSA, false, [
    'sign',
    'verify',
  ]) as Promise<webcrypto.CryptoKeyPair>;

export const createMockTsa = async (port = 0) => {
  const caKeys = await keyPair();
  const caCert = await makeCert({
    subject: 'Paper Trail MOCK TSA Root (untrusted)',
    issuer: 'Paper Trail MOCK TSA Root (untrusted)',
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    serial: 1,
    ca: true,
    timeStamping: false,
  });
  const tsaKeys = await keyPair();
  const tsaCert = await makeCert({
    subject: 'Paper Trail MOCK TSA',
    issuer: 'Paper Trail MOCK TSA Root (untrusted)',
    publicKey: tsaKeys.publicKey,
    signingKey: caKeys.privateKey,
    serial: 2,
    ca: false,
    timeStamping: true,
  });
  const plainKeys = await keyPair();
  const plainCert = await makeCert({
    subject: 'Paper Trail MOCK signer without EKU',
    issuer: 'Paper Trail MOCK TSA Root (untrusted)',
    publicKey: plainKeys.publicKey,
    signingKey: caKeys.privateKey,
    serial: 3,
    ca: false,
    timeStamping: false,
  });

  let mode: MockTsaMode = 'ok';
  let serial = 1000;
  let requests = 0;

  const reply = async (body: Uint8Array): Promise<ArrayBuffer> => {
    const req = pkijs.TimeStampReq.fromBER(body);
    if (mode === 'reject')
      return new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status: 2 }) })
        .toSchema()
        .toBER(false);

    const messageImprint =
      mode === 'wrong-imprint'
        ? new pkijs.MessageImprint({
            hashAlgorithm: req.messageImprint.hashAlgorithm,
            hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(32).fill(7) }),
          })
        : req.messageImprint;
    const nonce = mode === 'wrong-nonce' ? new asn1js.Integer({ value: 42 }) : req.nonce;
    const tst = new pkijs.TSTInfo({
      version: 1,
      policy: '1.3.6.1.4.1.55555.1.1',
      messageImprint,
      serialNumber: new asn1js.Integer({ value: ++serial }),
      // Whole seconds, like most real TSAs; accuracy says how far off that may be.
      genTime: new Date(Math.floor(Date.now() / 1000) * 1000),
      accuracy: new pkijs.Accuracy({ seconds: 1 }),
      ordering: false,
      ...(mode === 'no-nonce' || !nonce ? {} : { nonce }),
    });
    const tstDer = tst.toSchema().toBER(false);
    const signer =
      mode === 'no-eku'
        ? { cert: plainCert, key: plainKeys.privateKey }
        : { cert: tsaCert, key: tsaKeys.privateKey };

    const signed = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: OID.tstInfo,
        eContent: new asn1js.OctetString({ valueHex: tstDer }),
      }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: signer.cert.issuer,
            serialNumber: signer.cert.serialNumber,
          }),
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({
                type: OID.contentType,
                values: [new asn1js.ObjectIdentifier({ value: OID.tstInfo })],
              }),
              new pkijs.Attribute({
                type: OID.messageDigest,
                values: [
                  new asn1js.OctetString({
                    valueHex: await webcrypto.subtle.digest('SHA-256', tstDer),
                  }),
                ],
              }),
              // RFC 3161 §2.4.2 / RFC 5035: binds the signature to this exact TSA certificate.
              ...(mode === 'no-ess'
                ? []
                : [
                    new pkijs.Attribute({
                      type: OID.signingCertificateV2,
                      values: [
                        new asn1js.Sequence({
                          value: [
                            new asn1js.Sequence({
                              value: [
                                new asn1js.Sequence({
                                  value: [
                                    new asn1js.OctetString({
                                      valueHex: await webcrypto.subtle.digest(
                                        'SHA-256',
                                        signer.cert.toSchema().toBER(false),
                                      ),
                                    }),
                                  ],
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                  ]),
            ],
          }),
        }),
      ],
      certificates: [signer.cert],
    });
    // bad-signature: signed with a key that does not belong to the certificate in the token.
    await signed.sign(mode === 'bad-signature' ? plainKeys.privateKey : signer.key, 0, 'SHA-256');

    return new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: 0 }),
      timeStampToken: new pkijs.ContentInfo({
        contentType: OID.signedData,
        content: signed.toSchema(true),
      }),
    })
      .toSchema()
      .toBER(false);
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests++;
      void (async () => {
        if (mode === 'http-500') return res.writeHead(500).end();
        if (mode === 'slow') await new Promise((r) => setTimeout(r, 3_000));
        if (mode === 'garbage')
          return res
            .writeHead(200, { 'content-type': 'application/timestamp-reply' })
            .end('not asn.1');
        try {
          const der = await reply(Buffer.concat(chunks));
          res
            .writeHead(200, { 'content-type': 'application/timestamp-reply' })
            .end(Buffer.from(der));
        } catch {
          res.writeHead(400).end();
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${bound}/tsr`,
    caCert,
    caPem: toPem(caCert),
    setMode: (m: MockTsaMode) => {
      mode = m;
    },
    get requests() {
      return requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export type MockTsa = Awaited<ReturnType<typeof createMockTsa>>;
