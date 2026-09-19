export type ServerEnv = {
  nodeEnv: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseServiceRoleKey: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  shiprocketEmail: string;
  shiprocketPassword: string;
  shiprocketPickupLocation: string;
  shiprocketPickupPincode: string;
  shiprocketWebhookToken: string;
};

let validated = false;

function value(name: string) {
  return process.env[name]?.trim() ?? "";
}

export function validateServerEnv(): void {
  if (validated || process.env["NODE_ENV"] !== "production") return;

  const required = [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "SHIPROCKET_EMAIL",
    "SHIPROCKET_PASSWORD",
    "SHIPROCKET_PICKUP_PINCODE",
    "SHIPROCKET_WEBHOOK_TOKEN",
  ];
  const missing = required.filter((name) => !value(name));
  if (missing.length) {
    throw new Error(`Missing required production environment variable(s): ${missing.join(", ")}`);
  }
  validated = true;
}

export function getServerEnv(): ServerEnv {
  validateServerEnv();
  return {
    nodeEnv: process.env["NODE_ENV"] ?? "development",
    supabaseUrl: value("SUPABASE_URL"),
    supabasePublishableKey: value("SUPABASE_PUBLISHABLE_KEY"),
    supabaseServiceRoleKey: value("SUPABASE_SERVICE_ROLE_KEY"),
    razorpayKeyId: value("RAZORPAY_KEY_ID"),
    razorpayKeySecret: value("RAZORPAY_KEY_SECRET"),
    razorpayWebhookSecret: value("RAZORPAY_WEBHOOK_SECRET"),
    shiprocketEmail: value("SHIPROCKET_EMAIL"),
    shiprocketPassword: value("SHIPROCKET_PASSWORD"),
    shiprocketPickupLocation: value("SHIPROCKET_PICKUP_LOCATION") || "Primary",
    shiprocketPickupPincode: value("SHIPROCKET_PICKUP_PINCODE"),
    shiprocketWebhookToken: value("SHIPROCKET_WEBHOOK_TOKEN"),
  };
}
