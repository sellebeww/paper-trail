// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import nodemailer, { type Transporter } from 'nodemailer';

export interface Notification {
  to: string;
  subject: string;
  text: string;
}

/** Delivery channel for reminders. Web push is on the roadmap; email and console exist today. */
export interface Notifier {
  readonly channel: string;
  send(n: Notification): Promise<void>;
}

/** b***@example.test — enough to debug, not enough to harvest. */
export const maskEmail = (email: string) => email.replace(/^(.)[^@]*/, '$1***');

/** Development: prints that a reminder would be sent, without the full address or the body. */
export class ConsoleNotifier implements Notifier {
  readonly channel = 'console';
  constructor(private readonly log: (line: string) => void = console.log) {}
  async send(n: Notification) {
    this.log(
      JSON.stringify({
        msg: 'reminder (console notifier)',
        to: maskEmail(n.to),
        subject: n.subject,
      }),
    );
  }
}

export class EmailNotifier implements Notifier {
  readonly channel = 'email';
  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
  ) {}

  /** SMTP_URL, e.g. smtps://user:pass@smtp.example.com:465 (nodemailer connection URL). */
  static fromUrl(url: string, from: string) {
    return new EmailNotifier(nodemailer.createTransport(url), from);
  }

  async send(n: Notification) {
    await this.transport.sendMail({ from: this.from, to: n.to, subject: n.subject, text: n.text });
  }
}
