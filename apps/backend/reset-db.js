const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    // Delete in correct order (respecting foreign keys)
    const itemsResult = await prisma.invoiceItem.deleteMany({});
    const invResult = await prisma.invoice.deleteMany({});
    const productsResult = await prisma.product.deleteMany({});
    const clientsResult = await prisma.client.deleteMany({});
    const filesResult = await prisma.importedFile.deleteMany({});
    console.log('✓ Invoice items deleted: ' + itemsResult.count);
    console.log('✓ Invoices deleted: ' + invResult.count);
    console.log('✓ Products deleted: ' + productsResult.count);
    console.log('✓ Clients deleted: ' + clientsResult.count);
    console.log('✓ ImportedFiles deleted: ' + filesResult.count);
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
