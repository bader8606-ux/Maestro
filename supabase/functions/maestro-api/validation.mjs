import { z } from "zod";
const benefit = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  titleAr: z.string().trim().max(300).optional(),
  completed: z.boolean(),
});
const money = z
  .number()
  .finite()
  .min(0)
  .max(9999999999)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001,
    "Use a maximum of two decimal places.",
  );
const date = z
  .string()
  .refine(
    (v) =>
      v === "" ||
      (/^\d{4}-\d{2}-\d{2}$/.test(v) &&
        !Number.isNaN(Date.parse(v)) &&
        new Date(v).toISOString().slice(0, 10) === v),
    "Enter a valid date.",
  );
export const sponsorSchema = z.object({
  name: z.string().trim().min(1, "Sponsor Name is required.").max(200),
  packageId: z.string().uuid().or(z.literal("")),
  contact: z.string().trim().max(100),
  mobile: z
    .string()
    .trim()
    .refine(
      (v) => !v || /^\+[1-9]\d{6,14}$/.test(v),
      "Use a country code, for example +966501234567.",
    ),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .or(z.literal("")),
  approval: z.enum(["Not Approved", "In Progress", "Approved"]),
  approvalDate: date,
  poIssued: z.boolean(),
  poNumber: z.string().trim().max(100),
  poDate: date,
  value: money.nullable(),
  consideration: z.string().trim().max(1000).optional(),
  payments: z
    .array(
      z.object({
        id: z.string().uuid(),
        amount: money.refine(
          (v) => v > 0,
          "Payment must be greater than zero.",
        ),
        date: date.refine((v) => !!v, "Payment date is required."),
        note: z.string().max(300),
      }),
    )
    .max(1000),
  benefits: z.array(benefit).max(300),
  notes: z.string().max(3000),
});

export const packageSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    benefits: z.array(z.string().trim().min(1).max(300)).max(300),
    benefitsAr: z.array(z.string().trim().max(300)).max(300).optional(),
    referenceValue: money.optional(),
  })
  .refine(
    (input) =>
      !input.benefitsAr?.length ||
      input.benefitsAr.length === input.benefits.length,
    {
      message:
        "Provide an Arabic entry for each English benefit, or leave the Arabic list empty.",
      path: ["benefitsAr"],
    },
  );
export const userSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(12).max(200),
  role: z.enum(["admin", "editor", "viewer"]),
});
export const accessSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]),
  active: z.boolean(),
  password: z.string().min(12).max(200).optional(),
});
