import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const newPassword = z.string().min(8, 'Passwords need at least 8 characters').max(200);

export const hashPassword = (password: string) => bcrypt.hash(password, 12);

/** The user fields that are safe to send to the browser. */
export function publicUser(user: {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  createdAt?: Date;
}) {
  const { id, name, email, isAdmin, createdAt } = user;
  return { id, name, email, isAdmin, ...(createdAt ? { createdAt } : {}) };
}
