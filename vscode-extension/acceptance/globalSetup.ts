import { prepareAcceptanceVSCode } from "./fixtures/vscodeDownload";

export default async function globalSetup(): Promise<void> {
  await prepareAcceptanceVSCode();
}
