import { prisma } from "../src/lib/db";
import { seedDemoData } from "../src/lib/demo";

async function main() {
  // Dev convenience: reset so re-seeding is idempotent, then load the shared
  // demo dataset (same content the in-app "Load demo data" button uses).
  await prisma.link.deleteMany();
  await prisma.itemTag.deleteMany();
  await prisma.fileAsset.deleteMany();
  await prisma.item.deleteMany();
  await prisma.projectRelation.deleteMany();
  await prisma.project.deleteMany();

  const { noteCount } = await seedDemoData();
  console.log(`Seeded ${noteCount} notes across 3 projects (Atlas <-> Orion connected, Nova isolated).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
