import { KMSClient } from "@aws-sdk/client-kms";
import dotenv from "dotenv";

dotenv.config();

const kms = new KMSClient({
  region: process.env.eu-north-1,
  credentials: {
    accessKeyId: process.env.AKIAYS2NUORA2Y2IQCHR,
    secretAccessKey: process.env.l6b1zVrKkePCHg6L45BQuP5YqAIs56vBx7ukeqsA
  }
});

export default kms;
