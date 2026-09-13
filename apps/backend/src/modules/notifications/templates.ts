/**
 * Notification templates (F2).
 *
 * Keyed by flag color. Each template has a subject (used for email) and body.
 * `{{placeholders}}` are filled in by renderTemplate() from InvoiceForNotify.
 *
 * Placeholders:
 *   {{clientName}}       — client.name
 *   {{invoiceNo}}
 *   {{amount}}           — pre-formatted TND amount
 *   {{dueDate}}          — locale-formatted or 'non défini'
 *   {{daysOverdue}}      — number
 *   {{companyName}}      — from CompanySettings (F3) or invoice.companyName
 *
 * These are hardcoded now but the shape lets us swap to a DB-backed
 * template store later without touching the engine.
 */

export type TemplateKey = 'yellow-reminder' | 'orange-firmer' | 'red-final-warning';

export type Template = {
  key: TemplateKey;
  subject: string;
  body: string;
};

export const TEMPLATES: Record<TemplateKey, Template> = {
  'yellow-reminder': {
    key: 'yellow-reminder',
    subject: 'Rappel de paiement — Facture {{invoiceNo}}',
    body:
`Bonjour {{clientName}},

Nous vous rappelons aimablement que la facture n°{{invoiceNo}} d'un montant de {{amount}}, échue le {{dueDate}}, est actuellement en attente de règlement depuis {{daysOverdue}} jour(s).

Merci de bien vouloir procéder au paiement dans les meilleurs délais. Si le règlement a déjà été effectué, veuillez ignorer ce message.

Cordialement,
{{companyName}}`,
  },
  'orange-firmer': {
    key: 'orange-firmer',
    subject: 'Relance — Facture {{invoiceNo}} en retard',
    body:
`Bonjour {{clientName}},

Malgré notre précédent rappel, la facture n°{{invoiceNo}} d'un montant de {{amount}}, échue le {{dueDate}}, demeure impayée à ce jour ({{daysOverdue}} jour(s) de retard).

Nous vous prions de bien vouloir régulariser cette situation sans délai. À défaut, nous serons contraints d'engager les démarches nécessaires au recouvrement.

Cordialement,
{{companyName}}`,
  },
  'red-final-warning': {
    key: 'red-final-warning',
    subject: 'Dernier avis avant mise en demeure — Facture {{invoiceNo}}',
    body:
`Bonjour {{clientName}},

Nous constatons que la facture n°{{invoiceNo}} d'un montant de {{amount}}, échue le {{dueDate}}, demeure impayée après {{daysOverdue}} jour(s) de retard et malgré nos précédentes relances.

Il s'agit d'un DERNIER AVIS avant l'établissement d'une mise en demeure officielle et l'engagement de toute procédure de recouvrement contentieux, qui pourrait entraîner des frais additionnels à votre charge.

Merci de régulariser cette situation dans les plus brefs délais.

Cordialement,
{{companyName}}`,
  },
};

export function templateForFlag(flag: string): TemplateKey | null {
  if (flag === 'yellow') return 'yellow-reminder';
  if (flag === 'orange') return 'orange-firmer';
  if (flag === 'red') return 'red-final-warning';
  return null;
}

export type InvoiceForNotify = {
  invoiceNo: string;
  amountFormatted: string;
  dueDateFormatted: string;
  daysOverdue: number;
  clientName: string;
  companyName: string;
};

export function renderTemplate(
  template: Template,
  ctx: InvoiceForNotify,
): { subject: string; body: string } {
  const replace = (input: string) =>
    input
      .replace(/{{invoiceNo}}/g, ctx.invoiceNo)
      .replace(/{{amount}}/g, ctx.amountFormatted)
      .replace(/{{dueDate}}/g, ctx.dueDateFormatted)
      .replace(/{{daysOverdue}}/g, String(ctx.daysOverdue))
      .replace(/{{clientName}}/g, ctx.clientName)
      .replace(/{{companyName}}/g, ctx.companyName);

  return { subject: replace(template.subject), body: replace(template.body) };
}
