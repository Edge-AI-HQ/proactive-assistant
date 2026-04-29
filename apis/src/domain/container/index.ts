export {
  gatewayHostHeaders,
  type ContainerRuntime,
  type ContainerRef,
  type ContainerState,
  type GenericContainerParams,
  type GatewayTarget,
  type ProbeOptions,
} from "./contracts.js";
export { getContainerRuntime } from "./provider_factory.js";

// Provider runtime initialization. Only Fly currently has prepare-time work
// (image digest check); Docker is a no-op. Called once from server bootstrap.
import { getContainerRuntime } from "./provider_factory.js";
export const prepareContainerRuntime = async (): Promise<void> => {
  await getContainerRuntime().prepare();
};
