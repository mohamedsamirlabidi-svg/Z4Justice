export type DemoFlagColor = 'green' | 'yellow' | 'orange' | 'red' | 'none';
export type DemoDocType = 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';
export type DemoAlertChannel = 'email' | 'sms' | 'whatsapp';

export type DemoAlertHistoryEntry = {
  id: string;
  sentAt: string;
  channel: DemoAlertChannel;
  templateKey: string;
  recipient: string;
  contentPreview: string;
  deliveryState: 'sent' | 'delivered' | 'opened';
  flagAtSend: DemoFlagColor;
};

export type DemoInvoiceItem = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  product?: {
    id?: string;
    name: string;
    sku?: string | null;
    description?: string | null;
  };
};

export type DemoInvoiceDetail = {
  id: string;
  invoiceNo: string;
  date: string;
  dueDate: string | null;
  status: string;
  currency: string;
  totalAmount: number;
  verified: boolean;
  totalHT: number;
  taxRate: number;
  taxAmount: number;
  timbreFiscal: number;
  orderNo: string | null;
  sourceFile: string | null;
  documentType: DemoDocType;
  companyName: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  paymentTerms: string | null;
  sellerAddress: string | null;
  sellerWebsite: string | null;
  rib: string | null;
  bank: string | null;
  consultationRef: string | null;
  responsable: string | null;
  amountInWords: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  client: {
    id: string;
    name: string;
    company: string | null;
    address: string | null;
    city: string | null;
    taxId: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
  };
  items: DemoInvoiceItem[];
  alertHistory: DemoAlertHistoryEntry[];
  flagStatus: DemoFlagColor;
  flagUpdatedAt: string | null;
  lastAlertAt: string | null;
  miseEnDemeureDocument?: string | null;
};

function buildMiseEnDemeureDocument(input: {
  senderName: string;
  senderAddress: string;
  senderPhone: string;
  senderEmail: string;
  recipientName: string;
  recipientAddress: string;
  subjectAction: string;
  demand: string;
  facts: string;
  priorRequests: string;
  deadlineDays: number;
  city: string;
  date: string;
  signatureName: string;
}) {
  return `MISE EN DEMEURE

Expéditeur :
Nom et prénom : ${input.senderName}
Adresse : ${input.senderAddress}
Téléphone : ${input.senderPhone}
E-mail : ${input.senderEmail}

Destinataire :
Nom / Société : ${input.recipientName}
Adresse : ${input.recipientAddress}

Objet : Mise en demeure de ${input.subjectAction}

Madame, Monsieur,

Par la présente, je vous mets formellement en demeure de ${input.demand}.

En effet, ${input.facts}.

Malgré ${input.priorRequests}, vous n’avez, à ce jour, pas donné suite à cette obligation.

En conséquence, je vous demande de procéder à ${input.demand} dans un délai de ${input.deadlineDays} jours à compter de la réception de la présente.

À défaut d’exécution dans ce délai, je me réserve le droit d’engager toute procédure ou action nécessaire afin de faire valoir mes droits, sans autre préavis.

Je vous prie de prendre les dispositions nécessaires dans les meilleurs délais.

Fait à ${input.city}, le ${input.date}

Signature
${input.signatureName}`;
}

export type DemoMonitoringRow = {
  id: string;
  invoiceNo: string;
  date: string;
  dueDate: string | null;
  totalAmount: number;
  currency: string;
  paymentStatus: string;
  flagStatus: DemoFlagColor;
  flagUpdatedAt: string | null;
  documentType: DemoDocType | null;
  client: { id: string; name: string } | null;
  alertHistory: DemoAlertHistoryEntry[];
  lastAlertAt: string | null;
};

const DEMO_INVOICES: DemoInvoiceDetail[] = [
  {
    id: 'demo-inv-001',
    invoiceNo: 'FAC-2026-014',
    date: '2026-09-02T08:30:00.000Z',
    dueDate: null,
    status: 'overdue',
    currency: 'TND',
    totalAmount: 12480,
    verified: false,
    totalHT: 10566,
    taxRate: 0.19,
    taxAmount: 2006.54,
    timbreFiscal: 0.6,
    orderNo: 'CMD-8831',
    sourceFile: 'C:\\Users\\Y055R1\\Documents\\GitHub\\FactureERM\\ACROBATE SOLUTION\\2026\\FACTURE\\FAC-2026-014.pdf',
    documentType: 'facture',
    companyName: 'Acrobate Solution',
    companyEmail: 'billing@acrobate-solution.tn',
    companyPhone: '+216 71 258 108',
    paymentTerms: 'Virement',
    sellerAddress: '4 Rue du Caire, 1001 Tunis',
    sellerWebsite: 'https://acrobate-solution.tn',
    rib: '10 000 000 080746 3788 95',
    bank: 'STB THAMEUR',
    consultationRef: 'CONS-2026-014',
    responsable: 'Nader Ben Ali',
    amountInWords: 'Douze mille quatre cent quatre-vingts dinars tunisiens',
    notes: 'Demo invoice for recording | {"clientAddress":"Avenue Habib Bourguiba, Tunis","clientCity":"Tunis","clientTaxId":"1234567/A/M/000","clientContactName":"Sana Trabelsi"}',
    createdAt: '2026-09-02T08:30:00.000Z',
    updatedAt: '2026-09-12T08:30:00.000Z',
    client: {
      id: 'demo-client-1',
      name: 'National Telecom',
      company: 'National Telecom',
      address: 'Avenue Habib Bourguiba, Tunis',
      city: 'Tunis',
      taxId: '1234567/A/M/000',
      contactName: 'Sana Trabelsi',
      email: 'compta@national-telecom.tn',
      phone: '+216 99 111 222',
    },
    items: [
      {
        id: 'demo-inv-001-item-1',
        description: 'Maintenance annuelle infrastructure réseau',
        quantity: 1,
        unitPrice: 7200,
        lineTotal: 7200,
        product: { id: 'demo-product-1', name: 'Network Support', sku: 'NET-SUP-001' },
      },
      {
        id: 'demo-inv-001-item-2',
        description: 'Support premium 24/7',
        quantity: 2,
        unitPrice: 2673,
        lineTotal: 5346,
        product: { id: 'demo-product-2', name: 'Premium Support', sku: 'SUP-24-7' },
      },
    ],
    alertHistory: [
      {
        id: 'alert-001-1',
        sentAt: '2026-09-05T09:10:00.000Z',
        channel: 'email',
        templateKey: 'mise_en_demeure_1',
        recipient: 'M. Sami Ben Youssef · agent public de recouvrement',
        contentPreview: 'Mise en demeure officielle: la facture FAC-2026-014 demeure impayée et un suivi administratif est requis.',
        deliveryState: 'opened',
        flagAtSend: 'orange',
      },
      {
        id: 'alert-001-2',
        sentAt: '2026-09-08T14:45:00.000Z',
        channel: 'sms',
        templateKey: 'mise_en_demeure_followup',
        recipient: '+216 99 111 222',
        contentPreview: 'Relance administrative: confirmation du règlement demandée après mise en demeure.',
        deliveryState: 'delivered',
        flagAtSend: 'red',
      },
      {
        id: 'alert-001-3',
        sentAt: '2026-09-10T11:25:00.000Z',
        channel: 'whatsapp',
        templateKey: 'mise_en_demeure_escalation',
        recipient: 'finance@national-telecom.tn',
        contentPreview: 'Escalade de la mise en demeure: dossier transmis pour traitement manuel et suivi juridique.',
        deliveryState: 'sent',
        flagAtSend: 'red',
      },
      {
        id: 'alert-001-4',
        sentAt: '2026-09-12T08:30:00.000Z',
        channel: 'email',
        templateKey: 'mise_en_demeure_account_manager',
        recipient: 'account-manager@acrobate-solution.tn',
        contentPreview: 'Alerte rouge: la mise en demeure reste ouverte et la réponse client est en attente.',
        deliveryState: 'sent',
        flagAtSend: 'red',
      },
    ],
    flagStatus: 'red',
    flagUpdatedAt: '2026-09-12T08:30:00.000Z',
    lastAlertAt: '2026-09-12T08:30:00.000Z',
    miseEnDemeureDocument: buildMiseEnDemeureDocument({
      senderName: 'Nader Ben Ali',
      senderAddress: '4 Rue du Caire, 1001 Tunis',
      senderPhone: '+216 71 258 108',
      senderEmail: 'billing@acrobate-solution.tn',
      recipientName: 'National Telecom',
      recipientAddress: 'Avenue Habib Bourguiba, Tunis',
      subjectAction: 'paiement',
      demand: 'régler la somme de 12 480 DT correspondant à la facture FAC-2026-014',
      facts: 'la facture FAC-2026-014 du 02/09/2026 reste impayée malgré les relances précédentes et l’échéance n’a pas été respectée',
      priorRequests: 'mes précédentes demandes et relances restées sans réponse',
      deadlineDays: 8,
      city: 'Tunis',
      date: '13/09/2026',
      signatureName: 'Nader Ben Ali',
    }),
  },
  {
    id: 'demo-inv-002',
    invoiceNo: 'FAC-2026-018',
    date: '2026-09-06T10:00:00.000Z',
    dueDate: '2026-09-18T00:00:00.000Z',
    status: 'pending',
    currency: 'TND',
    totalAmount: 8420,
    verified: true,
    totalHT: 7094.12,
    taxRate: 0.19,
    taxAmount: 1325.28,
    timbreFiscal: 0.6,
    orderNo: 'CMD-8842',
    sourceFile: 'C:\\Users\\Y055R1\\Documents\\GitHub\\FactureERM\\ACROBATE SOLUTION\\2026\\FACTURE\\FAC-2026-018.pdf',
    documentType: 'facture',
    companyName: 'Acrobate Solution',
    companyEmail: 'billing@acrobate-solution.tn',
    companyPhone: '+216 71 258 108',
    paymentTerms: 'Virement',
    sellerAddress: '4 Rue du Caire, 1001 Tunis',
    sellerWebsite: 'https://acrobate-solution.tn',
    rib: '10 000 000 080746 3788 95',
    bank: 'STB THAMEUR',
    consultationRef: 'CONS-2026-018',
    responsable: 'Amina Jaziri',
    amountInWords: 'Huit mille quatre cent vingt dinars tunisiens',
    notes: 'Second reminder demo | {"clientAddress":"Immeuble B, Centre Urbain Nord","clientCity":"Tunis","clientTaxId":"1478523/D/001","clientContactName":"Yassine Mouelhi"}',
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-11T15:15:00.000Z',
    client: {
      id: 'demo-client-2',
      name: 'Meditel Services',
      company: 'Meditel Services',
      address: 'Immeuble B, Centre Urbain Nord',
      city: 'Tunis',
      taxId: '1478523/D/001',
      contactName: 'Yassine Mouelhi',
      email: 'billing@meditel-services.tn',
      phone: '+216 97 555 100',
    },
    items: [
      {
        id: 'demo-inv-002-item-1',
        description: 'Licence SaaS annuelle',
        quantity: 1,
        unitPrice: 5400,
        lineTotal: 5400,
        product: { id: 'demo-product-3', name: 'SaaS License', sku: 'SAAS-AN-01' },
      },
      {
        id: 'demo-inv-002-item-2',
        description: 'Onboarding et configuration',
        quantity: 1,
        unitPrice: 1694.12,
        lineTotal: 1694.12,
        product: { id: 'demo-product-4', name: 'Onboarding', sku: 'ONB-001' },
      },
    ],
    alertHistory: [
      {
        id: 'alert-002-1',
        sentAt: '2026-09-09T09:20:00.000Z',
        channel: 'email',
        templateKey: 'due_soon_notice',
        recipient: 'billing@meditel-services.tn',
        contentPreview: 'Votre facture FAC-2026-018 arrive à échéance dans 5 jours.',
        deliveryState: 'delivered',
        flagAtSend: 'yellow',
      },
      {
        id: 'alert-002-2',
        sentAt: '2026-09-11T15:15:00.000Z',
        channel: 'sms',
        templateKey: 'due_soon_followup',
        recipient: '+216 97 555 100',
        contentPreview: 'Petit rappel: la facture FAC-2026-018 devient prioritaire aujourd’hui.',
        deliveryState: 'sent',
        flagAtSend: 'orange',
      },
    ],
    flagStatus: 'orange',
    flagUpdatedAt: '2026-09-11T15:15:00.000Z',
    lastAlertAt: '2026-09-11T15:15:00.000Z',
    miseEnDemeureDocument: null,
  },
  {
    id: 'demo-inv-003',
    invoiceNo: 'FAC-2026-021',
    date: '2026-09-09T13:15:00.000Z',
    dueDate: '2026-09-20T00:00:00.000Z',
    status: 'sent',
    currency: 'TND',
    totalAmount: 3160,
    verified: true,
    totalHT: 2657.14,
    taxRate: 0.19,
    taxAmount: 502.0,
    timbreFiscal: 0.6,
    orderNo: 'Q-2026-021',
    sourceFile: 'C:\\Users\\Y055R1\\Documents\\GitHub\\FactureERM\\ACROBATE SOLUTION\\2026\\DEVIS\\DEV-2026-021.pdf',
    documentType: 'devis',
    companyName: 'Acrobate Solution',
    companyEmail: 'sales@acrobate-solution.tn',
    companyPhone: '+216 71 258 108',
    paymentTerms: 'Par chèque',
    sellerAddress: '4 Rue du Caire, 1001 Tunis',
    sellerWebsite: 'https://acrobate-solution.tn',
    rib: '10 000 000 080746 3788 95',
    bank: 'STB THAMEUR',
    consultationRef: 'CONS-2026-021',
    responsable: 'Noura Ben Youssef',
    amountInWords: 'Trois mille cent soixante dinars tunisiens',
    notes: 'Quote in follow-up mode | {"clientAddress":"Zone Industrielle Charguia","clientCity":"Tunis","clientTaxId":"1999001/H/009","clientContactName":"Hatem Bousnina"}',
    createdAt: '2026-09-09T13:15:00.000Z',
    updatedAt: '2026-09-12T09:00:00.000Z',
    client: {
      id: 'demo-client-3',
      name: 'Société El Manar',
      company: 'Société El Manar',
      address: 'Zone Industrielle Charguia',
      city: 'Tunis',
      taxId: '1999001/H/009',
      contactName: 'Hatem Bousnina',
      email: 'contact@elmanar.tn',
      phone: '+216 71 555 010',
    },
    items: [
      {
        id: 'demo-inv-003-item-1',
        description: 'Étude technique',
        quantity: 1,
        unitPrice: 1450,
        lineTotal: 1450,
        product: { id: 'demo-product-5', name: 'Technical Study', sku: 'STUDY-01' },
      },
      {
        id: 'demo-inv-003-item-2',
        description: 'Préparation devis projet',
        quantity: 1,
        unitPrice: 1207.14,
        lineTotal: 1207.14,
        product: { id: 'demo-product-6', name: 'Proposal Prep', sku: 'PROP-01' },
      },
    ],
    alertHistory: [
      {
        id: 'alert-003-1',
        sentAt: '2026-09-12T09:00:00.000Z',
        channel: 'email',
        templateKey: 'status_watch',
        recipient: 'contact@elmanar.tn',
        contentPreview: 'Le document est suivi automatiquement pour éviter un retard de validation.',
        deliveryState: 'opened',
        flagAtSend: 'yellow',
      },
    ],
    flagStatus: 'yellow',
    flagUpdatedAt: '2026-09-12T09:00:00.000Z',
    lastAlertAt: '2026-09-12T09:00:00.000Z',
    miseEnDemeureDocument: null,
  },
  {
    id: 'demo-inv-004',
    invoiceNo: 'FAC-2026-024',
    date: '2026-09-12T09:00:00.000Z',
    dueDate: '2026-10-02T00:00:00.000Z',
    status: 'paid',
    currency: 'TND',
    totalAmount: 19100,
    verified: true,
    totalHT: 16067.23,
    taxRate: 0.19,
    taxAmount: 3031.17,
    timbreFiscal: 0.6,
    orderNo: 'PO-2026-024',
    sourceFile: 'C:\\Users\\Y055R1\\Documents\\GitHub\\FactureERM\\GAMESTREAM ATLAS\\2026\\FACTURE\\FAC-2026-024.pdf',
    documentType: 'facture',
    companyName: 'GameStream ATLAS',
    companyEmail: 'finance@gamestream.atlas.tn',
    companyPhone: '+216 74 120 800',
    paymentTerms: 'Virement',
    sellerAddress: 'Rte de La Marsa, Tunis',
    sellerWebsite: 'https://gamestream-atlas.tn',
    rib: '11 222 333 444555 6666 77',
    bank: 'Attijari Bank',
    consultationRef: 'CONS-2026-024',
    responsable: 'Amir Jallouli',
    amountInWords: 'Dix-neuf mille cent dinars tunisiens',
    notes: 'Paid invoice demo | {"clientAddress":"Rue des Entrepreneurs, Sfax","clientCity":"Sfax","clientTaxId":"5566778/L/120","clientContactName":"Meriem Chaabane"}',
    createdAt: '2026-09-12T09:00:00.000Z',
    updatedAt: '2026-09-12T12:30:00.000Z',
    client: {
      id: 'demo-client-4',
      name: 'Atlas Distribution',
      company: 'Atlas Distribution',
      address: 'Rue des Entrepreneurs, Sfax',
      city: 'Sfax',
      taxId: '5566778/L/120',
      contactName: 'Meriem Chaabane',
      email: 'accounts@atlas-distribution.tn',
      phone: '+216 74 120 900',
    },
    items: [
      {
        id: 'demo-inv-004-item-1',
        description: 'Pack distribution licences',
        quantity: 5,
        unitPrice: 2800,
        lineTotal: 14000,
        product: { id: 'demo-product-7', name: 'Distribution Licenses', sku: 'DIST-05' },
      },
      {
        id: 'demo-inv-004-item-2',
        description: 'Support technique',
        quantity: 1,
        unitPrice: 2067.23,
        lineTotal: 2067.23,
        product: { id: 'demo-product-8', name: 'Technical Support', sku: 'SUP-TECH' },
      },
    ],
    alertHistory: [
      {
        id: 'alert-004-1',
        sentAt: '2026-09-12T10:45:00.000Z',
        channel: 'email',
        templateKey: 'payment_received',
        recipient: 'accounts@atlas-distribution.tn',
        contentPreview: 'Paiement enregistré et facture FAC-2026-024 marquée comme soldée.',
        deliveryState: 'opened',
        flagAtSend: 'green',
      },
    ],
    flagStatus: 'green',
    flagUpdatedAt: '2026-09-12T12:30:00.000Z',
    lastAlertAt: '2026-09-12T12:30:00.000Z',
    miseEnDemeureDocument: null,
  },
  {
    id: 'demo-inv-005',
    invoiceNo: 'FAC-2026-029',
    date: '2026-09-13T07:45:00.000Z',
    dueDate: '2026-09-30T00:00:00.000Z',
    status: 'pending',
    currency: 'TND',
    totalAmount: 5320,
    verified: true,
    totalHT: 4478.99,
    taxRate: 0.19,
    taxAmount: 840.41,
    timbreFiscal: 0.6,
    orderNo: 'BL-2026-029',
    sourceFile: 'C:\\Users\\Y055R1\\Documents\\GitHub\\FactureERM\\GAMESTREAM ATLAS\\2026\\BL\\BL-2026-029.pdf',
    documentType: 'bon_de_livraison',
    companyName: 'GameStream ATLAS',
    companyEmail: 'logistics@gamestream.atlas.tn',
    companyPhone: '+216 74 120 800',
    paymentTerms: 'Espèce',
    sellerAddress: 'Rte de La Marsa, Tunis',
    sellerWebsite: 'https://gamestream-atlas.tn',
    rib: '11 222 333 444555 6666 77',
    bank: 'Attijari Bank',
    consultationRef: 'CONS-2026-029',
    responsable: 'Oussama Jeddi',
    amountInWords: 'Cinq mille trois cent vingt dinars tunisiens',
    notes: 'Delivery note demo | {"clientAddress":"Avenue de Paris, Tunis","clientCity":"Tunis","clientTaxId":"9988776/C/008","clientContactName":"Nadia Khemiri"}',
    createdAt: '2026-09-13T07:45:00.000Z',
    updatedAt: '2026-09-13T07:45:00.000Z',
    client: {
      id: 'demo-client-5',
      name: 'Clinique du Lac',
      company: 'Clinique du Lac',
      address: 'Avenue de Paris, Tunis',
      city: 'Tunis',
      taxId: '9988776/C/008',
      contactName: 'Nadia Khemiri',
      email: 'procurement@clinique-du-lac.tn',
      phone: '+216 70 200 300',
    },
    items: [
      {
        id: 'demo-inv-005-item-1',
        description: 'Livraison matériel informatique',
        quantity: 8,
        unitPrice: 420,
        lineTotal: 3360,
        product: { id: 'demo-product-9', name: 'Hardware Delivery', sku: 'DLV-HW-01' },
      },
      {
        id: 'demo-inv-005-item-2',
        description: 'Installation et mise en service',
        quantity: 1,
        unitPrice: 1118.99,
        lineTotal: 1118.99,
        product: { id: 'demo-product-10', name: 'Installation', sku: 'INST-01' },
      },
    ],
    alertHistory: [],
    flagStatus: 'none',
    flagUpdatedAt: '2026-09-13T07:45:00.000Z',
    lastAlertAt: null,
    miseEnDemeureDocument: null,
  },
];

export function getDemoInvoiceById(id?: string | null) {
  if (!id) return null;
  return DEMO_INVOICES.find((invoice) => invoice.id === id) ?? null;
}

export function getDemoMonitoringRows(): DemoMonitoringRow[] {
  return DEMO_INVOICES.map((invoice) => ({
    id: invoice.id,
    invoiceNo: invoice.invoiceNo,
    date: invoice.date,
    dueDate: invoice.dueDate,
    totalAmount: invoice.totalAmount,
    currency: invoice.currency,
    paymentStatus: invoice.status,
    flagStatus: invoice.flagStatus,
    flagUpdatedAt: invoice.flagUpdatedAt,
    documentType: invoice.documentType,
    client: invoice.client ? { id: invoice.client.id, name: invoice.client.name } : null,
    alertHistory: invoice.alertHistory,
    lastAlertAt: invoice.lastAlertAt,
  }));
}

export function getDemoInvoiceIds(): string[] {
  return DEMO_INVOICES.map((invoice) => invoice.id);
}
