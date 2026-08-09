import { InstanceSettingsForm } from "~/app/_components/instance-settings-form";

export default function InstanceSettingsPage() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-4 py-16">
      <h1 className="text-3xl font-extrabold tracking-tight">Instance settings</h1>
      <InstanceSettingsForm />
    </main>
  );
}
