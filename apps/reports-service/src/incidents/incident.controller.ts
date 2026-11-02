import { Controller } from "@nestjs/common";
import { MessagePattern, Payload, RpcException } from "@nestjs/microservices";
import { IncidentRepository } from "./incident.repository";
import { IncidentError, authorize } from "./incident-domain";

@Controller()
export class IncidentRpcController {
  constructor(private readonly incidents: IncidentRepository) {}
  @MessagePattern("incidents.read")
  read(@Payload() p: any) {
    return this.invoke(p, () =>
      this.incidents.read(p.actor, p.operation, p.id, p.input),
    );
  }
  @MessagePattern("incidents.mutate")
  mutate(@Payload() p: any) {
    return this.invoke(p, () =>
      this.incidents.mutate(p.actor, p.operation, p.id, p.body, p.key),
    );
  }
  private async invoke(p: any, run: () => Promise<any>) {
    try {
      authorize(p.actor);
      const [user] = await this.incidents.db.query(
        "SELECT role FROM public.users WHERE id=$1",
        [p.actor.userId],
      );
      if (!user || user.role !== p.actor.role)
        throw new IncidentError(403, "role_changed", "Refresh your session");
      return await run();
    } catch (error) {
      const known = error instanceof IncidentError;
      throw new RpcException({
        statusCode: known ? error.statusCode : 500,
        code: known ? error.code : "incident_internal_error",
        message: known ? error.message : "Incident operation failed",
      });
    }
  }
}
