declare module "electron" {
  export interface Shell {
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
  }

  export const shell: Shell;
}
