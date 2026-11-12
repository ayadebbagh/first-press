import nodemailer from 'nodemailer';
import { databaseClient } from '../db/connection.mjs';

const port = Number(process.env.SMTP_PORT || 587);
if (!process.env.SMTP_HOST || !process.env.AUTH_EMAIL_FROM || (!Number.isInteger(port) || port<1 || port>65535)) {
  console.error('Mail worker requires SMTP_HOST, AUTH_EMAIL_FROM and a valid TLS SMTP port.');
  process.exit(1);
}
const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port,
  secure: port === 465, requireTLS: true,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  disableFileAccess: true, disableUrlAccess: true,
});
const client = databaseClient();
let running = true;
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { running=false; });
try {
  await client.connect();
  do {
    // Expired payloads are never sent and links are removed from retained records.
    await client.query("UPDATE mail_outbox SET status='failed',body=NULL,lease_at=NULL WHERE status IN ('queued','sending') AND (expires_at<=now() OR attempts>=5)");
    const { rows: [mail] } = await client.query(`UPDATE mail_outbox SET status='sending',attempts=attempts+1,lease_at=now()
      WHERE id=(SELECT id FROM mail_outbox WHERE expires_at>now() AND attempts<5 AND
      ((status='queued' AND available_at<=now()) OR (status='sending' AND lease_at<now()-interval '2 minutes'))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    if (mail) {
      try {
        await transport.sendMail({ from: process.env.AUTH_EMAIL_FROM, to: mail.recipient, subject: mail.subject,
          text: mail.body });
        await client.query("UPDATE mail_outbox SET status='sent',body=NULL,sent_at=now(),lease_at=NULL WHERE id=$1", [mail.id]);
        console.log('Authentication email delivered.');
      } catch {
        await client.query(`UPDATE mail_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
          body=CASE WHEN attempts>=5 THEN NULL ELSE body END,lease_at=NULL,
          available_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::int)) WHERE id=$1`, [mail.id]);
        console.error('Authentication email delivery failed; retry scheduled when eligible.');
      }
    } else if (!process.argv.includes('--once')) await new Promise(resolve => setTimeout(resolve, 2000));
  } while (running && !process.argv.includes('--once'));
} catch {
  console.error('Mail worker stopped. Check private database/SMTP configuration.');
  process.exitCode=1;
} finally { transport.close(); await client.end(); }
