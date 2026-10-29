//scripts/create-org.ts
import { createPool } from '../src/db/pool.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1];
    return null;
  };

  const orgName = getArg('--org-name');
  const slug = getArg('--slug');
  const adminEmail = getArg('--admin-email');
  const adminName = getArg('--admin-name');
  const locationName = getArg('--location-name') || undefined;
  const timezone = getArg('--timezone') || undefined;

  if (!orgName || !slug || !adminEmail || !adminName) {
    console.error('Usage: --org-name <name> --slug <slug> --admin-email <email> --admin-name <name> [--location-name <name>] [--timezone <tz>]');
    process.exit(1);
  }

  const pool = createPool();
  try {
    const result = await createOrgWithAdmin(pool, {
      orgName,
      slug,
      adminEmail,
      adminName,
      locationName,
      timezone
    });

    console.log(`Organization ID: ${result.orgId}`);
    console.log(`Slug: ${slug}`);
    console.log(`Admin Email: ${adminEmail}`);
    console.log(`Generated Password: ${result.password}`);
    console.log("Save this password now. It will not be shown again.");
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();