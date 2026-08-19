//#region 模型/类型
export type CaptionRole = "user" | "assistant";
//#endregion

//#region 公开 API
export class CaptionLog {
  private user = "";
  private assistant = "";

  beginUserTurn(): void {
    this.user = "";
  }

  appendDelta(role: CaptionRole, delta: string): string {
    if (role === "user") this.user = `${this.user}${delta}`;
    else this.assistant = `${this.assistant}${delta}`;
    return role === "user" ? this.user : this.assistant;
  }

  complete(role: CaptionRole, text?: string): string {
    if (text !== undefined) {
      if (role === "user") this.user = text;
      else this.assistant = text;
    }
    return role === "user" ? this.user : this.assistant;
  }
}
//#endregion
