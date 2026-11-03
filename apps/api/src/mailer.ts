// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Mail for account links (verify email, reset password). Sent by the API directly rather than through the broker,
// so the one-time tokens never sit in a queue or a dead-letter queue.
import nodemailer, { type Transporter } from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Development only: prints the whole mail, links included, so you can click them. Refused in production. */
export class ConsoleMailer implements Mailer {
  async send(mail: Mail) {
    console.log(JSON.stringify({ msg: 'mail (console mailer, development only)', ...mail }));
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url); // connects on first send, so a down server does not stop startup
  }
  async send(mail: Mail) {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Tests: keeps what would have been sent. */
export class MemoryMailer implements Mailer {
  readonly outbox: Mail[] = [];
  async send(mail: Mail) {
    this.outbox.push(mail);
  }
}
