import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfig } from '../../config/config';
import { PrismaService } from '../prisma/prisma.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  tenantId?: string | null;
}

/**
 * Transactional email. When SMTP_URL is not configured, messages are stored in the outbox with
 * status LOGGED and nothing is sent; callers must offer another path (for example showing an
 * invitation link to the admin) instead of pretending an email went out.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transport: Transporter | null;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.transport = config.env.SMTP_URL ? nodemailer.createTransport(config.env.SMTP_URL) : null;
  }

  get configured(): boolean {
    return this.transport !== null;
  }

  async send(message: MailMessage): Promise<{ delivered: boolean }> {
    const row = await this.prisma.system.emailOutbox.create({
      data: { tenantId: message.tenantId ?? null, toAddress: message.to, subject: message.subject, textBody: message.text, status: 'QUEUED' },
    });
    if (!this.transport) {
      await this.prisma.system.emailOutbox.update({ where: { id: row.id }, data: { status: 'LOGGED' } });
      if (!this.config.isProduction) this.logger.log(`Email not configured; stored message "${message.subject}" in outbox ${row.id}`);
      return { delivered: false };
    }
    try {
      await this.transport.sendMail({ from: this.config.env.MAIL_FROM, to: message.to, subject: message.subject, text: message.text });
      await this.prisma.system.emailOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date() } });
      return { delivered: true };
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await this.prisma.system.emailOutbox.update({ where: { id: row.id }, data: { status: 'FAILED', error: msg } });
      this.logger.error(`Email delivery failed: ${msg}`);
      return { delivered: false };
    }
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
