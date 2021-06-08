import { Bucket } from "@aws-cdk/aws-s3";
import {
    CloudFrontAllowedCachedMethods,
    CloudFrontAllowedMethods,
    CloudFrontWebDistribution,
    FunctionEventType,
    HttpVersion,
    OriginAccessIdentity,
    PriceClass,
    ViewerCertificate,
    ViewerProtocolPolicy,
} from "@aws-cdk/aws-cloudfront";
import * as cloudfront from "@aws-cdk/aws-cloudfront";
import { Construct as CdkConstruct, CfnOutput, Duration, RemovalPolicy } from "@aws-cdk/core";
import { FromSchema } from "json-schema-to-ts";
import {
    DeleteObjectsOutput,
    DeleteObjectsRequest,
    ListObjectsV2Output,
    ListObjectsV2Request,
} from "aws-sdk/clients/s3";
import chalk from "chalk";
import { CreateInvalidationRequest, CreateInvalidationResult } from "aws-sdk/clients/cloudfront";
import { log } from "../utils/logger";
import { s3Sync } from "../utils/s3-sync";
import AwsProvider from "../classes/AwsProvider";
import Construct from "../classes/Construct";

export const STATIC_WEBSITE_DEFINITION = {
    type: "object",
    properties: {
        type: { const: "static-website" },
        path: { type: "string" },
        domain: {
            anyOf: [
                { type: "string" },
                {
                    type: "array",
                    items: { type: "string" },
                },
            ],
        },
        certificate: { type: "string" },
        security: {
            type: "object",
            properties: {
                allowIframe: { type: "boolean" },
            },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
    required: ["type", "path"],
} as const;

type Configuration = FromSchema<typeof STATIC_WEBSITE_DEFINITION>;

export class StaticWebsite extends CdkConstruct implements Construct {
    private readonly bucketNameOutput: CfnOutput;
    private readonly domainOutput: CfnOutput;
    private readonly cnameOutput: CfnOutput;
    private readonly distributionIdOutput: CfnOutput;

    constructor(
        scope: CdkConstruct,
        private readonly id: string,
        readonly configuration: Configuration,
        private readonly provider: AwsProvider
    ) {
        super(scope, id);

        if (configuration.domain !== undefined && configuration.certificate === undefined) {
            throw new Error(
                `Invalid configuration for the static website ${id}: if a domain is configured, then a certificate ARN must be configured as well.`
            );
        }

        const bucket = new Bucket(this, "Bucket", {
            // For a static website, the content is code that should be versioned elsewhere
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const cloudFrontOAI = new OriginAccessIdentity(this, "OriginAccessIdentity", {
            comment: `Identity that represents CloudFront for the ${id} static website.`,
        });

        const securityHeaders: Record<string, { value: string }> = {
            "x-frame-options": { value: "SAMEORIGIN" },
            "x-content-type-options": { value: "nosniff" },
            "x-xss-protection": { value: "1; mode=block" },
            "strict-transport-security": { value: "max-age=63072000" },
        };
        if (this.configuration.security?.allowIframe === true) {
            delete securityHeaders["x-frame-options"];
        }
        const jsonHeaders = JSON.stringify(securityHeaders, undefined, 4);
        /**
         * CloudFront function that manipulates the HTTP responses to add security headers.
         */
        const code = `function handler(event) {
    var response = event.response;
    response.headers = Object.assign({}, ${jsonHeaders}, response.headers);
    return response;
}`;
        const edgeFunction = new cloudfront.Function(this, "EdgeFunction", {
            functionName: `${this.provider.stackName}-${this.provider.region}-${id}-response`,
            code: cloudfront.FunctionCode.fromInline(code),
        });

        const distribution = new CloudFrontWebDistribution(this, "CDN", {
            comment: `${provider.stackName} ${id} website CDN`,
            // Cheapest option by default (https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_DistributionConfig.html)
            priceClass: PriceClass.PRICE_CLASS_100,
            // Enable http2 transfer for better performances
            httpVersion: HttpVersion.HTTP2,
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            // Send all page requests to index.html
            defaultRootObject: "index.html",
            // Origins are where CloudFront fetches content
            originConfigs: [
                {
                    // The CDK will automatically allow CloudFront to access S3 via the "Origin Access Identity"
                    s3OriginSource: {
                        s3BucketSource: bucket,
                        originAccessIdentity: cloudFrontOAI,
                    },
                    behaviors: [
                        {
                            isDefaultBehavior: true,
                            allowedMethods: CloudFrontAllowedMethods.GET_HEAD_OPTIONS,
                            cachedMethods: CloudFrontAllowedCachedMethods.GET_HEAD_OPTIONS,
                            functionAssociations: [
                                {
                                    function: edgeFunction,
                                    eventType: FunctionEventType.VIEWER_RESPONSE,
                                },
                            ],
                            forwardedValues: {
                                // Do not forward the query string or cookies
                                queryString: false,
                                cookies: {
                                    forward: "none",
                                },
                            },
                            // Serve files with gzip for browsers that support it (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html)
                            compress: true,
                            // Cache files in CloudFront for 1 hour by default
                            defaultTtl: Duration.hours(1),
                        },
                    ],
                },
            ],
            // For SPA we need dynamic pages to be served by index.html
            errorConfigurations: [
                {
                    errorCode: 404,
                    errorCachingMinTtl: 0,
                    responseCode: 200,
                    responsePagePath: "/index.html",
                },
            ],
            viewerCertificate: this.compileViewerCertificate(configuration),
        });

        // CloudFormation outputs
        this.bucketNameOutput = new CfnOutput(this, "BucketName", {
            description: "Name of the bucket that stores the static website.",
            value: bucket.bucketName,
        });
        let websiteDomain: string = distribution.distributionDomainName;
        if (configuration.domain !== undefined) {
            // In case of multiple domains, we take the first one
            websiteDomain = typeof configuration.domain === "string" ? configuration.domain : configuration.domain[0];
        }
        this.domainOutput = new CfnOutput(this, "Domain", {
            description: "Website domain name.",
            value: websiteDomain,
        });
        this.cnameOutput = new CfnOutput(this, "CloudFrontCName", {
            description: "CloudFront CNAME.",
            value: distribution.distributionDomainName,
        });
        this.distributionIdOutput = new CfnOutput(this, "DistributionId", {
            description: "ID of the CloudFront distribution.",
            value: distribution.distributionId,
        });
    }

    private compileViewerCertificate(config: Configuration) {
        if (config.certificate === undefined) {
            return undefined;
        }

        let aliases: string[] = [];
        if (config.domain !== undefined) {
            aliases = typeof config.domain === "string" ? [config.domain] : config.domain;
        }

        return {
            aliases: aliases,
            props: {
                acmCertificateArn: config.certificate,
                // See https://docs.aws.amazon.com/fr_fr/cloudfront/latest/APIReference/API_ViewerCertificate.html
                sslSupportMethod: "sni-only",
                minimumProtocolVersion: "TLSv1.1_2016",
            },
        } as ViewerCertificate;
    }

    commands(): Record<string, () => Promise<void>> {
        return {
            upload: this.uploadWebsite.bind(this),
        };
    }

    outputs(): Record<string, () => Promise<string | undefined>> {
        return {
            url: () => this.getUrl(),
            cname: () => this.getCName(),
        };
    }

    references(): Record<string, Record<string, unknown>> {
        return {};
    }

    async postDeploy(): Promise<void> {
        await this.uploadWebsite();
    }

    async uploadWebsite(): Promise<void> {
        log(`Deploying the static website '${this.id}'`);

        const bucketName = await this.getBucketName();
        if (bucketName === undefined) {
            throw new Error(
                `Could not find the bucket in which to deploy the '${this.id}' website: did you forget to run 'serverless deploy' first?`
            );
        }

        log(`Uploading directory '${this.configuration.path}' to bucket '${bucketName}'`);
        const { hasChanges } = await s3Sync({
            aws: this.provider,
            localPath: this.configuration.path,
            bucketName,
        });
        if (hasChanges) {
            await this.clearCDNCache();
        }

        const domain = await this.getDomain();
        if (domain !== undefined) {
            log(`Deployed ${chalk.green(`https://${domain}`)}`);
        }
    }

    private async clearCDNCache(): Promise<void> {
        const distributionId = await this.getDistributionId();
        if (distributionId === undefined) {
            return;
        }
        await this.provider.request<CreateInvalidationRequest, CreateInvalidationResult>(
            "CloudFront",
            "createInvalidation",
            {
                DistributionId: distributionId,
                InvalidationBatch: {
                    // This should be a unique ID: we use a timestamp
                    CallerReference: Date.now().toString(),
                    Paths: {
                        // Invalidate everything
                        Items: ["/*"],
                        Quantity: 1,
                    },
                },
            }
        );
    }

    async preRemove(): Promise<void> {
        const bucketName = await this.getBucketName();
        if (bucketName === undefined) {
            // No bucket found => nothing to delete!
            return;
        }

        log(
            `Emptying S3 bucket '${bucketName}' for the '${this.id}' static website, else CloudFormation will fail (it cannot delete a non-empty bucket)`
        );
        const data = await this.provider.request<ListObjectsV2Request, ListObjectsV2Output>("S3", "listObjectsV2", {
            Bucket: bucketName,
        });
        if (data.Contents === undefined) {
            return;
        }
        const keys = data.Contents.map((item) => item.Key).filter((key): key is string => key !== undefined);
        await this.provider.request<DeleteObjectsRequest, DeleteObjectsOutput>("S3", "deleteObjects", {
            Bucket: bucketName,
            Delete: {
                Objects: keys.map((key) => ({ Key: key })),
            },
        });
    }

    async getUrl(): Promise<string | undefined> {
        const domain = await this.getDomain();
        if (domain === undefined) {
            return undefined;
        }

        return `https://${domain}`;
    }

    async getBucketName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.bucketNameOutput);
    }

    async getDomain(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.domainOutput);
    }

    async getCName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.cnameOutput);
    }

    async getDistributionId(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.distributionIdOutput);
    }
}
