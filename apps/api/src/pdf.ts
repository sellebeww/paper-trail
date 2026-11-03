// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// One-document summary of an evidence pack for readers who will not run a verifier (legal aides, unions).
// pdfkit: maintained, streaming, small. Trade-off: the built-in fonts are Latin-1 only, so characters outside
// it (emoji, other scripts) are replaced by "?" here; the JSON pack keeps the original text.
import { sha256Hex, type Entry, type EvidencePack } from '@paper-trail/chain';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

export const LEGAL_DISCLAIMER =
  'Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.';

const CATEGORY: Record<string, string> = {
  kerja: 'Kerja',
  sewa: 'Sewa kos',
  freelance: 'Freelance',
  gig: 'Gig / kurir / pengemudi',
  lainnya: 'Lainnya',
};
const TYPE: Record<string, string> = {
  note: 'Catatan',
  photo: 'Foto',
  file: 'Berkas',
  witness_cosign: 'Saksi',
};

/** Keeps what the standard PDF fonts can draw; everything else (per code point) becomes "?". */
export const latin1 = (text: string): string =>
  Array.from(text.normalize('NFC'))
    .map((ch) => (/^[\x20-\x7e -ÿ]$/.test(ch) ? ch : ch === '\n' || ch === '\t' ? ' ' : '?'))
    .join('');

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
const wib = (iso: string) => {
  const d = new Date(Date.parse(iso) + 7 * 3_600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} WIB`;
};
const clip = (text: string, max: number) => {
  const flat = latin1(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** One-line description of an entry for the table; never invents content for undisclosed entries. */
export const summarize = (e: Entry, requestedTo: number): string => {
  if (e.seq > requestedTo) return '(entri penghubung ke jangkar waktu; isi tidak disertakan)';
  const p = e.payload as Record<string, unknown> | undefined;
  if (!p) return '(isi tidak disertakan)';
  switch (e.type) {
    case 'note':
      return clip(String(p['text'] ?? ''), 110);
    case 'photo':
      return `Foto${p['caption'] ? `: ${clip(String(p['caption']), 70)}` : ''} (sha ${String(p['content_sha256']).slice(0, 8)})`;
    case 'file':
      return `Berkas: ${clip(String(p['name'] ?? ''), 60)} (${Math.max(1, Math.round(Number(p['size']) / 1024))} KB, sha ${String(p['content_sha256']).slice(0, 8)})`;
    default:
      return `${clip(String(p['witness_name'] ?? ''), 50)} menyaksikan catatan nomor ${String(p['target_seq'])}`;
  }
};

export const verifyUrl = (webOrigin: string, packHash: string) =>
  `${new URL(webOrigin).origin}/verifikasi#${packHash}`;

const MARGIN = 50;
const PAGE_BOTTOM = 770;

export const renderPackPdf = async (pack: EvidencePack, webOrigin: string): Promise<Buffer> => {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: 'Ringkasan Paket Bukti Paper Trail',
      Author: 'Paper Trail',
      Subject: `pack_hash ${pack.pack_hash}`,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve) => doc.on('end', resolve));

  const width = doc.page.width - MARGIN * 2;
  const h1 = (t: string) =>
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor('#111')
      .text(t, MARGIN, doc.y, { paragraphGap: 4 });
  const body = (t: string, size = 10) =>
    doc
      .font('Helvetica')
      .fontSize(size)
      .fillColor('#111')
      .text(latin1(t), MARGIN, doc.y, { width });
  const mono = (t: string) =>
    doc.font('Courier').fontSize(8.5).fillColor('#111').text(t, MARGIN, doc.y, { width });
  const label = (t: string) =>
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#444').text(t, MARGIN, doc.y, { width });
  const ensure = (h: number) => {
    if (doc.y + h > PAGE_BOTTOM) doc.addPage();
  };

  const first = pack.entries[0]!;
  const last = pack.entries[pack.entries.length - 1]!;
  const anchors = pack.anchors;
  const lastAnchor = anchors.length
    ? anchors.reduce((a, b) => (a.gen_time > b.gen_time ? a : b))
    : undefined;
  const partial = pack.scope.from_seq > 0 || pack.scope.to_seq < pack.scope.ledger_head_seq;

  // ---- Cover ----
  doc.font('Helvetica').fontSize(10).fillColor('#444').text('PAPER TRAIL', MARGIN, MARGIN);
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor('#111')
    .text('Ringkasan Paket Bukti', MARGIN, doc.y, { paragraphGap: 6 });
  if (pack.ledger.title)
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .text(latin1(pack.ledger.title), MARGIN, doc.y, { paragraphGap: 2 });
  if (pack.ledger.category)
    body(`Kategori: ${CATEGORY[pack.ledger.category] ?? pack.ledger.category}`);
  doc.moveDown(0.8);

  const facts: [string, string][] = [
    [
      'Periode catatan',
      `${utc(first.created_at)} sampai ${utc(last.created_at)} (WIB = UTC+7; awal ${wib(first.created_at)})`,
    ],
    [
      'Jumlah catatan di paket ini',
      `${pack.entries.length} (nomor ${pack.scope.from_seq} sampai ${pack.scope.to_seq})`,
    ],
    [
      'Waktu jangkar terakhir',
      lastAnchor
        ? `${utc(lastAnchor.gen_time)} (cap waktu dari pihak ketiga, mencakup catatan sampai nomor ${Math.max(...anchors.map((a) => a.head_seq))})`
        : 'Belum ada jangkar waktu dari pihak ketiga di paket ini',
    ],
    ['Paket dibuat', utc(pack.generated_at)],
  ];
  for (const [k, v] of facts) {
    label(k);
    body(v);
    doc.moveDown(0.3);
  }
  label('Hash kepala rantai (catatan terakhir di paket)');
  mono(pack.head.hash);
  doc.moveDown(0.3);
  label('Hash paket (pack_hash)');
  mono(pack.pack_hash);
  doc.moveDown(0.5);

  if (partial) {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#92400e')
      .text('Ekspor sebagian', MARGIN, doc.y, { paragraphGap: 2 });
    body(
      `Paket ini memuat catatan nomor ${pack.scope.from_seq} sampai ${pack.scope.to_seq}, sedangkan buku catatan punya sampai nomor ${pack.scope.ledger_head_seq}. ` +
        (pack.scope.from_seq > 0
          ? 'Catatan sebelumnya tidak disertakan; keterkaitannya dengan rantai sebelum rentang ini tidak dapat dibuktikan dari paket ini saja. '
          : '') +
        'Tanpa jangkar waktu, rentang ini tidak membuktikan letaknya di dalam buku catatan.',
      9,
    );
    doc.moveDown(0.4);
  }

  const qrTop = doc.y;
  const url = verifyUrl(webOrigin, pack.pack_hash);
  doc.image(
    await QRCode.toBuffer(url, { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' }),
    MARGIN,
    qrTop,
    { width: 100 },
  );
  const sideX = MARGIN + 115;
  const sideW = width - 115;
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#111')
    .text('Periksa paket ini', sideX, qrTop, { width: sideW });
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(
      'Pindai kode QR untuk membuka halaman verifikasi, lalu tempel berkas paket JSON. Cocokkan hash paket di halaman itu dengan hash paket di atas. Pemeriksaan dilakukan di perangkat Anda dan tidak mengirim isi catatan ke mana pun.',
      sideX,
      doc.y,
      { width: sideW },
    );
  doc
    .font('Courier')
    .fontSize(6)
    .fillColor('#444')
    .text(url, sideX, doc.y + 2, { width: sideW });
  doc.x = MARGIN;
  doc.y = Math.max(doc.y, qrTop + 110);
  doc.moveDown(0.8);

  h1('Apa yang dibuktikan, dan apa yang tidak');
  for (const line of [
    'Dibuktikan: catatan di paket ini tidak diubah, dihapus, atau disisipi setelah dibuat (rantai hash utuh), dan, bila ada jangkar waktu, catatan itu sudah ada paling lambat pada waktu jangkar.',
    'Dibuktikan: tanda tangan saksi dibuat oleh pemegang kunci yang sama atas catatan yang disebutkan.',
    'TIDAK dibuktikan: bahwa isi catatan itu benar, siapa penulis sebenarnya, atau bahwa tidak ada catatan lain yang tidak ditunjukkan.',
    'TIDAK dibuktikan: identitas saksi atau bahwa saksi bebas dari pengaruh pemilik catatan. Nama saksi diketik sendiri oleh saksi.',
  ])
    body(`- ${line}`, 9);
  doc.moveDown(0.6);
  doc
    .font('Helvetica-Oblique')
    .fontSize(9)
    .fillColor('#111')
    .text(LEGAL_DISCLAIMER, MARGIN, doc.y, { width });

  // ---- Entries table ----
  doc.addPage();
  h1('Daftar catatan');
  const cols = [
    { title: 'Seq', x: MARGIN, w: 28 },
    { title: 'Waktu server (UTC)', x: MARGIN + 30, w: 98 },
    { title: 'Tipe', x: MARGIN + 130, w: 42 },
    { title: 'Ringkasan', x: MARGIN + 175, w: 245 },
    { title: 'Hash', x: MARGIN + 425, w: 70 },
  ];
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444');
    const y = doc.y;
    for (const c of cols) doc.text(c.title, c.x, y, { width: c.w });
    doc
      .moveTo(MARGIN, y + 12)
      .lineTo(MARGIN + width, y + 12)
      .strokeColor('#999')
      .lineWidth(0.5)
      .stroke();
    doc.y = y + 16;
  };
  header();
  for (const e of pack.entries) {
    const summary = summarize(e, pack.scope.requested_to_seq);
    doc.font('Helvetica').fontSize(8.5);
    const rowH = Math.max(12, doc.heightOfString(summary, { width: cols[3]!.w }) + 4);
    if (doc.y + rowH > PAGE_BOTTOM) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor('#111');
    doc.text(String(e.seq), cols[0]!.x, y, { width: cols[0]!.w });
    doc.text(e.created_at.slice(0, 19).replace('T', ' '), cols[1]!.x, y, { width: cols[1]!.w });
    doc.text(TYPE[e.type] ?? e.type, cols[2]!.x, y, { width: cols[2]!.w });
    doc.text(summary, cols[3]!.x, y, { width: cols[3]!.w });
    doc.font('Courier').text(e.entry_hash.slice(0, 8), cols[4]!.x, y, { width: cols[4]!.w });
    doc.y = y + rowH;
  }
  doc.moveDown(0.5);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#444')
    .text(
      'Kolom Hash menampilkan 8 karakter pertama dari hash penuh setiap catatan; hash penuh ada di paket JSON.',
      MARGIN,
      doc.y,
      { width },
    );

  // ---- Witnesses ----
  doc.moveDown(1);
  ensure(60);
  h1('Saksi');
  if (!pack.witnesses.length) body('Tidak ada tanda tangan saksi yang diungkapkan di paket ini.');
  for (const w of pack.witnesses) {
    ensure(46);
    body(
      `${clip(w.witness_name, 60)} menyaksikan catatan nomor ${w.target_seq} (tercatat sebagai catatan nomor ${w.entry_seq}).`,
    );
    doc
      .font('Courier')
      .fontSize(8)
      .fillColor('#444')
      .text(
        `${w.alg}, sidik jari kunci ${sha256Hex(Buffer.from(w.witness_pub, 'base64url')).slice(0, 16)}`,
        MARGIN,
        doc.y,
        { width },
      );
    doc.moveDown(0.4);
  }

  // ---- Anchors ----
  doc.moveDown(0.6);
  ensure(60);
  h1('Jangkar waktu (RFC 3161)');
  if (!anchors.length)
    body(
      'Tidak ada jangkar waktu di paket ini. Waktu pada catatan adalah waktu server dan belum dikuatkan pihak ketiga.',
    );
  for (const a of anchors) {
    ensure(46);
    let host = a.tsa_label;
    try {
      host = new URL(a.tsa_label).host || host;
    } catch {
      /* keep the label as is */
    }
    body(
      `Mencakup catatan sampai nomor ${a.head_seq}. Waktu dari TSA: ${utc(a.gen_time)}. TSA: ${clip(host, 60)}.`,
    );
    doc
      .font('Courier')
      .fontSize(8)
      .fillColor('#444')
      .text(
        `hash kepala ${a.head_hash.slice(0, 32)}...  sertifikat dalam token: ${a.certs.length}`,
        MARGIN,
        doc.y,
        { width },
      );
    doc.moveDown(0.4);
  }

  // ---- Footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin; without this pdfkit starts a new page for every footer.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#666');
    doc.text(
      `Hash paket ${pack.pack_hash}  -  halaman ${i + 1} dari ${range.count}`,
      MARGIN,
      doc.page.height - 36,
      {
        width,
        align: 'left',
        lineBreak: false,
      },
    );
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
};
