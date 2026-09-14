export interface RunnerLauncher {
  launch(taskId: string): Promise<number>;
}
