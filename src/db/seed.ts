
import bcrypt from "bcrypt";
import prisma from "../shared/prisma";



export const initiateSuperAdmin = async () => {
  const existingAdmin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
  });

  if (existingAdmin) {
    console.log("Admin already exists, skipping...");
    return;
  }

  const hashedPassword = await bcrypt.hash("admin123", 10);

  const user = await prisma.user.create({
    data: {
      name: "Super Admin",
      email: "admin@example.com",
      role: "ADMIN",
    },
  });

  await prisma.userAuth.create({
    data: {
      userId: user.id,
      password: hashedPassword,
    },
  });

  console.log("Admin seeded successfully");
};