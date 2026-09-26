/**
 * Create a user, or reset an existing user's password.
 *   npm run user:create -- <email> <name> <password>
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('Usage: npm run user:create -- <email> <name> <password>');
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);
const user = await prisma.user.upsert({
  where: { email: email.toLowerCase() },
  create: { email: email.toLowerCase(), name, passwordHash },
  update: { name, passwordHash },
});
console.log(`Saved user ${user.name} <${user.email}>`);
await prisma.$disconnect();
