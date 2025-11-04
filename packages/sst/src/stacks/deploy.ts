import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { useBus } from "../bus.js";
import { ConfigOptions, useProject } from "../project.js";
import { useAWSClient, useAWSProvider } from "../credentials.js";
import { Logger } from "../logger.js";
import { type CloudFormationStackArtifact } from "aws-cdk-lib/cx-api";
import { type Stack } from "@aws-sdk/client-cloudformation";
import {
  filterOutputs,
  isFailed,
  monitor,
  StackDeploymentResult,
} from "./monitor.js";
import { VisibleError } from "../error.js";

export async function publishAssets(stacks: CloudFormationStackArtifact[]) {
  Logger.debug("Publishing assets");
  const { cdk } = useProject().config;

  const results: Record<string, any> = {};
  for (const stackArtifact of stacks) {
    const cfnStack = await getCloudFormationStack(stackArtifact);
    await addInUseExports(stackArtifact, cfnStack);
    const deployment = await createCdkDeployments();
    await buildAndPublishAssets(deployment, stackArtifact);
    results[stackArtifact.stackName] = {
      isUpdate: cfnStack && cfnStack.StackStatus !== "REVIEW_IN_PROGRESS",
      params: await buildCloudFormationStackParams(deployment, stackArtifact, cdk),
    };
  }
  return results;
}

export async function deployMany(stacks: CloudFormationStackArtifact[]) {
  if (stacks.length === 0) {
    throw new VisibleError("No stacks to deploy");
  }
  Logger.debug(
    "Deploying stacks",
    stacks.map((s) => s.stackName)
  );
  const { CloudFormationStackArtifact } = await import("aws-cdk-lib/cx-api");
  await useAWSProvider();
  const bus = useBus();
  const complete = new Set<string>();
  const todo = new Set(stacks.map((s) => s.id));

  const results: Record<string, StackDeploymentResult> = {};

  return new Promise<typeof results>((resolve) => {
    async function trigger() {
      for (const stack of stacks) {
        if (!todo.has(stack.id)) continue;
        Logger.debug("Checking if", stack.id, "is ready to deploy");

        if (
          stack.dependencies.some(
            (dep) =>
              dep instanceof CloudFormationStackArtifact &&
              !complete.has(dep.id) &&
              stacks.some((s) => s.id === dep.id)
          )
        )
          continue;

        deploy(stack).then((result) => {
          results[stack.id] = result;
          complete.add(stack.id);

          if (isFailed(result.status))
            stacks.forEach((s) => {
              if (todo.delete(s.stackName)) {
                complete.add(s.stackName);
                results[s.id] = {
                  status: "DEPENDENCY_FAILED",
                  outputs: {},
                  errors: {},
                };
                bus.publish("stack.status", {
                  stackID: s.id,
                  status: "DEPENDENCY_FAILED",
                });
              }
            });

          if (complete.size === stacks.length) {
            resolve(results);
          }

          trigger();
        });

        todo.delete(stack.id);
      }
    }

    trigger();
  });
}

export async function deploy(
  stack: CloudFormationStackArtifact
): Promise<StackDeploymentResult> {
  const bus = useBus();
  const { cdk } = useProject().config;
  Logger.debug("Deploying stack", stack.id);
  try {
    const cfnStack = await getCloudFormationStack(stack);
    await addInUseExports(stack, cfnStack);
    bus.publish("stack.status", {
      stackID: stack.stackName,
      status: "PUBLISH_ASSETS_IN_PROGRESS",
    });
    const deployment = await createCdkDeployments();
    await buildAndPublishAssets(deployment, stack);

    if (
      cfnStack?.StackStatus === "ROLLBACK_COMPLETE" ||
      cfnStack?.StackStatus === "ROLLBACK_FAILED"
    ) {
      await deleteCloudFormationStack(stack.stackName);
    }

    const stackParams = await buildCloudFormationStackParams(deployment, stack, cdk);
    try {
      cfnStack && cfnStack.StackStatus !== "REVIEW_IN_PROGRESS"
        ? await updateCloudFormationStack(stackParams)
        : await createCloudFormationStack(stackParams);
    } catch (e: any) {
      if (
        e.name === "ValidationError" &&
        e.message.includes("No updates are to be performed.")
      ) {
        bus.publish("stack.status", {
          stackID: stack.stackName,
          status: "SKIPPED",
        });
        return {
          errors: {},
          outputs: filterOutputs(
            Object.fromEntries(
              (cfnStack!.Outputs || []).map((o) => [o.OutputKey, o.OutputValue])
            )
          ),
          status: "SKIPPED",
        };
      }
      throw e;
    }
    bus.publish("stack.updated", {
      stackID: stack.stackName,
    });
    return monitor(stack.stackName);
  } catch (ex: any) {
    Logger.debug("Failed to deploy stack", stack.id, ex);
    if (ex.message === "No updates are to be performed.") {
      return monitor(stack.stackName);
    }
    bus.publish("stack.status", {
      stackID: stack.stackName,
      status: "UPDATE_FAILED",
    });
    return {
      errors: {
        stack: ex.message,
      },
      outputs: {},
      status: "UPDATE_FAILED",
    };
  }
}

async function addInUseExports(
  stackArtifact: CloudFormationStackArtifact,
  cfnStack?: Stack
) {
  if (!cfnStack) return;

  // Get old outputs
  const oldOutputs = cfnStack.Outputs || [];

  // Get new exports
  // note: that we only want to handle outputs exported by CDK.
  // ie.
  // "Outputs": {
  //   "ExportsOutputRefauthUserPoolA78B038B8D9965B5": {
  //     "Value": {
  //       "Ref": "authUserPoolA78B038B"
  //     },
  //     "Export": {
  //       "Name": "frank-acme-auth:ExportsOutputRefauthUserPoolA78B038B8D9965B5"
  //     }
  //   },
  const newTemplate = JSON.parse(await getLocalTemplate(stackArtifact));
  const newOutputs = newTemplate.Outputs || {};
  const newExportNames = Object.keys(newOutputs)
    .filter((outputKey) => outputKey.startsWith("ExportsOutput"))
    .filter((outputKey) => newOutputs[outputKey].Export)
    .map((outputKey) => newOutputs[outputKey].Export.Name);

  // Add missing exports
  // ie.
  // Outputs [{
  //   OutputKey: (String)
  //   OutputValue: (String)
  //   Description: (String)
  //   ExportName: (String)
  // }]
  let isDirty = false;
  await Promise.all(
    oldOutputs
      .filter((output) => output.OutputKey?.startsWith("ExportsOutput"))
      .filter((output) => output.ExportName)
      // filter exports not in the new template (ie. CloudFormation will be removing)
      .filter((output) => !newExportNames.includes(output.ExportName))
      // filter the exports still in-use by other stacks
      .map(async (output) => {
        const imports = await listImports(output.ExportName!);
        // update template
        if (imports.length > 0) {
          Logger.debug(
            `deploy stack: addInUseExports: export ${
              output.ExportName
            } used in ${imports.join(", ")}`
          );
          newTemplate.Outputs = newTemplate.Outputs || {};
          newTemplate.Outputs[output.OutputKey!] = {
            Description: `Output added by SST b/c exported value still used in ${imports.join(
              ", "
            )}`,
            Value: output.OutputValue,
            Export: {
              Name: output.ExportName,
            },
          };
          isDirty = true;
        }
      })
  );

  // Save new template
  if (isDirty) {
    await saveLocalTemplate(
      stackArtifact,
      JSON.stringify(newTemplate, null, 2)
    );
  }
}

async function createCdkDeployments() {
  const cdkToolkitUrl = await import.meta.resolve!("@aws-cdk/toolkit-lib");
  const cdkToolkitPath = fileURLToPath(cdkToolkitUrl);
  const { Deployments } = await import(
    pathToFileURL(
      path.resolve(cdkToolkitPath, "..", "api", "deployments", "deployments.js")
    ).href
  );
  const { IoHelper } = await import(
    pathToFileURL(
      path.resolve(cdkToolkitPath, "..", "api", "io", "private", "io-helper.js")
    ).href
  );
  const provider = await useAWSProvider();
  await useAWSProvider();
  const ioHelper = IoHelper.fromActionAwareIoHost({
    notify: (msg: any) => {},
    requestResponse: (msg: any) => {},
  });
  return new Deployments({
    sdkProvider: provider,
    ioHelper,
  });
}

async function buildAndPublishAssets(
  deployment: any,
  stackArtifact: CloudFormationStackArtifact
) {
  const { AssetManifestArtifact } = await import("aws-cdk-lib/cx-api");
  const { AssetManifest } = await import("cdk-assets");
  for (const artifact of stackArtifact.dependencies) {
    if (!AssetManifestArtifact.isAssetManifestArtifact(artifact)) continue;
    const manifest = AssetManifest.fromFile(artifact.file);

    for (const entry of manifest.entries) {
      await deployment.buildSingleAsset(artifact, manifest, entry, {
        stack: stackArtifact,
        roleArn: stackArtifact.cloudFormationExecutionRoleArn,
        stackName: stackArtifact.stackName,
      });

      await deployment.publishSingleAsset(manifest, entry, {
        stack: stackArtifact,
        roleArn: stackArtifact.cloudFormationExecutionRoleArn,
        stackName: stackArtifact.stackName,
      });
    }
  }
}

async function buildCloudFormationStackParams(
  deployment: any,
  stack: CloudFormationStackArtifact,
  cdkOptions?: ConfigOptions["cdk"]
) {
  const env = await deployment.envs.accessStackForMutableStackOperations(stack);
  const executionRoleArn = cdkOptions?.cloudFormationExecutionRole ?? await env.replacePlaceholders(stack.cloudFormationExecutionRoleArn);
  const s3Url = stack
    .stackTemplateAssetObjectUrl!.replace(
      "${AWS::AccountId}",
      env.resolvedEnvironment.account
    )
    .match(/s3:\/\/([^/]+)\/(.*)$/);
  const templateUrl = s3Url
    ? `https://s3.${env.resolvedEnvironment.region}.amazonaws.com/${s3Url[1]}/${s3Url[2]}`
    : stack.stackTemplateAssetObjectUrl;

  return {
    StackName: stack.stackName,
    TemplateURL: templateUrl,
    RoleARN: executionRoleArn,
    //TemplateBody: bodyParameter.TemplateBody,
    //Parameters: stackParams.apiParameters,
    Parameters: [],
    Capabilities: [
      "CAPABILITY_IAM",
      "CAPABILITY_NAMED_IAM",
      "CAPABILITY_AUTO_EXPAND",
    ],
    Tags: Object.entries(stack.tags ?? {}).map(([Key, Value]) => ({
      Key,
      Value,
    })),
  };
}

async function getCloudFormationStack(stack: CloudFormationStackArtifact) {
  const { CloudFormationClient, DescribeStacksCommand } = await import(
    "@aws-sdk/client-cloudformation"
  );
  const client = useAWSClient(CloudFormationClient);
  try {
    const { Stacks: stacks } = await client.send(
        new DescribeStacksCommand({
        StackName: stack.stackName,
      })
    );
    if (!stacks || stacks.length === 0) return;
    return stacks[0];
  } catch (e: any) {
    if (
      e.name === "ValidationError" &&
      e.message.includes("Stack with id") &&
      e.message.includes("does not exist")
    ) {
      return;
    } else {
      throw e;
    }
  }
}

async function createCloudFormationStack(input: any) {
  const { CloudFormationClient, CreateStackCommand } = await import(
    "@aws-sdk/client-cloudformation"
  );
  const client = useAWSClient(CloudFormationClient);
  await client.send(new CreateStackCommand(input));
}

async function updateCloudFormationStack(input: any) {
  const { CloudFormationClient, UpdateStackCommand } = await import(
    "@aws-sdk/client-cloudformation"
  );
  const client = useAWSClient(CloudFormationClient);
  await client.send(new UpdateStackCommand(input));
}

async function deleteCloudFormationStack(stackName: string) {
  const { CloudFormationClient, DescribeStacksCommand, DeleteStackCommand } =
    await import("@aws-sdk/client-cloudformation");
  const client = useAWSClient(CloudFormationClient);
  try {
    await client.send(new DeleteStackCommand({ StackName: stackName }));
    while (true) {
      const { Stacks: stacks } = await client.send(
        new DescribeStacksCommand({
          StackName: stackName,
        })
      );
      if (!stacks || stacks.length === 0) {
        return;
      }
      const stack = stacks[0];
      if (stack.StackStatus === "DELETE_IN_PROGRESS") {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (stack.StackStatus === "DELETE_COMPLETE") {
        return;
      }
      if (stack.StackStatus === "DELETE_FAILED") {
        throw new Error(
          `Failed deleting stack ${stackName} that had previously failed creation (current state: ${stack.StackStatus})`
        );
      }
    }
  } catch (e: any) {
    if (
      e.name === "ValidationError" &&
      e.message.includes("Stack with id") &&
      e.message.includes("does not exist")
    ) {
      return;
    }
    throw e;
  }
}

async function listImports(exportName: string) {
  const { CloudFormationClient, ListImportsCommand } = await import(
    "@aws-sdk/client-cloudformation"
  );
  const client = useAWSClient(CloudFormationClient);
  try {
    const ret = await client.send(
      new ListImportsCommand({
        ExportName: exportName,
      })
    );
    return ret.Imports || [];
  } catch (e: any) {
    if (
      e.name === "ValidationError" &&
      e.message.includes("is not imported by any stack")
    ) {
      return [];
    }
    throw e;
  }
}

async function getLocalTemplate(stack: CloudFormationStackArtifact) {
  const fs = await import("fs/promises");
  const fileContent = await fs.readFile(stack.templateFullPath);
  return fileContent.toString();
}

async function saveLocalTemplate(
  stack: CloudFormationStackArtifact,
  content: string
) {
  const fs = await import("fs/promises");
  await fs.writeFile(stack.templateFullPath, content);
}
