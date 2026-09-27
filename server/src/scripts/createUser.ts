/**
 * Create a user, or reset an existing user's password.
 *   npm run user:create -- <email> <name> <password> [--admin]
 * The very first user is always made an admin. Mostly for bootstrapping; after
 * that, admins can manage users from Settings in the app.
 */
import { prisma } from '../db.js';
import { hashPassword } from '../users.js';

const args = process.argv.slice(2);
const makeAdmin = args.includes('--admin');
const [email, name, password] = args.filter((a) => a !== '--admin');
if (!email || !name || !password) {
  console.error('Usage: npm run user:create -- <email> <name> <password> [--admin]');
  process.exit(1);
}

const isFirstUser = (await prisma.user.count()) === 0;
const passwordHash = await hashPassword(password);
const user = await prisma.user.upsert({
  where: { email: email.toLowerCase() },
  create: { email: email.toLowerCase(), name, passwordHash, isAdmin: makeAdmin || isFirstUser },
  update: { name, passwordHash, ...(makeAdmin ? { isAdmin: true } : {}) },
});
console.log(`Saved user ${user.name} <${user.email}>${user.isAdmin ? ' (admin)' : ''}`);
await prisma.$disconnect();
