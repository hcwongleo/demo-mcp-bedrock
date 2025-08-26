"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BedrockMcpStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const iam = require("aws-cdk-lib/aws-iam");
const elbv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
const s3 = require("aws-cdk-lib/aws-s3");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const path = require("path");
class BedrockMcpStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const prefix = props?.namePrefix || 'MCP';
        const allowedCidr = '4.0.0.0/23';
        // Create S3 bucket for code deployment
        const codeBucket = new s3.Bucket(this, `${prefix}-CodeBucket`, {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // Deploy only essential application files to S3
        const codeDeployment = new s3deploy.BucketDeployment(this, `${prefix}-CodeDeployment`, {
            sources: [
                s3deploy.Source.asset(path.resolve(__dirname, '../../'), {
                    exclude: [
                        '*',
                        '!src/**',
                        '!conf/**',
                        '!chatbot.py',
                        '!pyproject.toml',
                        '!uv.lock',
                        '!.env'
                    ]
                })
            ],
            destinationBucket: codeBucket,
            destinationKeyPrefix: 'mcp-app/',
            prune: false
        });
        // Create VPC
        const vpc = new ec2.Vpc(this, `${prefix}-VPC`, {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                }
            ]
        });
        // Create Security Group for ALB
        const albSg = new ec2.SecurityGroup(this, `${prefix}-ALB-SG`, {
            vpc,
            allowAllOutbound: true,
            description: 'Security group for Application Load Balancer',
            disableInlineRules: true
        });
        albSg.addIngressRule(ec2.Peer.ipv4(allowedCidr), ec2.Port.tcp(8502), `Streamlit UI access from ${allowedCidr}`);
        // Create Security Group for EC2
        const ec2Sg = new ec2.SecurityGroup(this, `${prefix}-EC2-SG`, {
            vpc,
            allowAllOutbound: true,
            description: 'Security group for EC2 instances'
        });
        ec2Sg.addIngressRule(ec2.Peer.securityGroupId(albSg.securityGroupId), ec2.Port.tcp(8502), 'Streamlit UI from ALB');
        // Create IAM Role
        const role = new iam.Role(this, 'EC2-Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
            ]
        });
        // Add Bedrock permissions
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel*',
                'bedrock:ListFoundationModels'
            ],
            resources: ['*']
        }));
        // Add S3 permissions to download code
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:ListBucket'
            ],
            resources: [
                codeBucket.bucketArn,
                `${codeBucket.bucketArn}/*`
            ]
        }));
        // Create Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, `${prefix}-ALB`, {
            vpc,
            internetFacing: true,
            securityGroup: albSg
        });
        const streamlitListener = alb.addListener('Streamlit', {
            port: 8502,
            protocol: elbv2.ApplicationProtocol.HTTP,
            open: false
        });
        // Create User Data that downloads local code from S3
        const userData = ec2.UserData.forLinux();
        userData.addCommands('#!/bin/bash', 'set -e', 
        // Logging function
        'log() { echo "$(date): $1" | tee -a /var/log/mcp-deployment.log; }', 'log "Starting MCP deployment with local code"', 
        // Set environment variables
        'export HOME=/root', 'export PATH="/usr/local/bin:$PATH"', 'export DEBIAN_FRONTEND=noninteractive', 
        // Update system and install dependencies
        'log "Updating system packages"', 'apt-get update -y', 'apt-get install -y software-properties-common curl wget git build-essential unzip', 
        // Install Python 3.12
        'log "Installing Python 3.12"', 'add-apt-repository -y ppa:deadsnakes/ppa', 'apt-get update -y', 'apt-get install -y python3.12 python3.12-venv python3.12-dev python3-pip', 
        // Install Node.js
        'log "Installing Node.js"', 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -', 'apt-get install -y nodejs', 
        // Install system dependencies
        'log "Installing system dependencies"', 'apt-get install -y portaudio19-dev libasound2-dev libportaudio2 libportaudiocpp0', 
        // Setup ubuntu user environment
        'log "Setting up ubuntu user environment"', 'su - ubuntu -c "curl -LsSf https://astral.sh/uv/install.sh | sh"', 'echo \'export PATH="/home/ubuntu/.local/bin:$PATH"\' >> /home/ubuntu/.bashrc', 
        // Create project directory
        'log "Creating project directory"', 'mkdir -p /home/ubuntu/demo_mcp_on_amazon_bedrock', 'chown ubuntu:ubuntu /home/ubuntu/demo_mcp_on_amazon_bedrock', 'cd /home/ubuntu/demo_mcp_on_amazon_bedrock', 
        // Download code from S3 instead of git clone
        'log "Downloading application code from S3"', `aws s3 sync s3://${codeBucket.bucketName}/mcp-app/ . --region ${cdk.Stack.of(this).region}`, 'log "Application code downloaded successfully"', 
        // Verify we have the correct config (should only have Nova Pro)
        'log "Verifying configuration"', 'cat conf/config.json', 
        // Set proper ownership
        'chown -R ubuntu:ubuntu /home/ubuntu/demo_mcp_on_amazon_bedrock', 'chmod 755 /home/ubuntu/demo_mcp_on_amazon_bedrock', 
        // Create necessary directories
        'log "Creating necessary directories"', 'mkdir -p logs tmp', 'chown -R ubuntu:ubuntu logs tmp', 
        // Remove Nova Sonic components if they exist
        'log "Removing Nova Sonic components"', 'rm -f src/nova_sonic_manager.py src/websocket_manager.py || true', 
        // Setup Python environment
        'log "Setting up Python environment"', 'su - ubuntu -c "', 'cd /home/ubuntu/demo_mcp_on_amazon_bedrock && \\', 'export PATH=\"/home/ubuntu/.local/bin:$PATH\" && \\', 'python3.12 -m venv .venv && \\', 'source .venv/bin/activate && \\', 'pip install --upgrade pip && \\', 'pip install uv && \\', 'uv sync --no-dev || pip install boto3 botocore fastapi uvicorn mcp openai aiohttp python-dotenv requests pandas pytz rx streamlit streamlit-cookies-controller streamlit-local-storage tzdata uvicorn websockets', '"', 
        // Configure environment (using instance role only)
        'log "Configuring environment"', 'cat > .env << EOL', 'AWS_REGION=' + cdk.Stack.of(this).region, 'LOG_DIR=./logs', 'CHATBOT_SERVICE_PORT=8502', 'MCP_SERVICE_HOST=127.0.0.1', 'MCP_SERVICE_PORT=7002', 'MCP_BASE_URL=http://127.0.0.1:7002', `API_KEY=${cdk.Names.uniqueId(this)}`, 'EOL', 'chown ubuntu:ubuntu .env', 'chmod 600 .env', 
        // Create startup script
        'log "Creating startup script"', 'cat > start_services_local.sh << EOL', '#!/bin/bash', 'cd /home/ubuntu/demo_mcp_on_amazon_bedrock', 'source .venv/bin/activate', 'export $(grep -v "^#" .env | xargs)', 'export PYTHONPATH=./src:$PYTHONPATH', '', '# Create log directories', 'mkdir -p ${LOG_DIR}', '', '# Kill any existing processes', 'pkill -f "python.*main.py" || true', 'pkill -f "streamlit" || true', 'sleep 3', '', '# Start MCP service', 'echo "$(date): Starting MCP service" >> ${LOG_DIR}/startup.log', 'nohup python src/main.py \\', '    --mcp-conf conf/config.json \\', '    --user-conf conf/user_mcp_config.json \\', '    --host ${MCP_SERVICE_HOST} \\', '    --port ${MCP_SERVICE_PORT} \\', '    > ${LOG_DIR}/mcp.log 2>&1 &', 'MCP_PID=$!', 'echo $MCP_PID > ${LOG_DIR}/mcp.pid', '', '# Wait for MCP service to start', 'sleep 15', '', '# Check if MCP service is running', 'if ! kill -0 $MCP_PID 2>/dev/null; then', '    echo "$(date): MCP service failed to start" >> ${LOG_DIR}/startup.log', '    exit 1', 'fi', '', '# Start Streamlit service', 'echo "$(date): Starting Streamlit service" >> ${LOG_DIR}/startup.log', 'nohup streamlit run chatbot.py \\', '    --server.port ${CHATBOT_SERVICE_PORT} \\', '    --server.address 0.0.0.0 \\', '    --server.headless true \\', '    > ${LOG_DIR}/streamlit.log 2>&1 &', 'STREAMLIT_PID=$!', 'echo $STREAMLIT_PID > ${LOG_DIR}/streamlit.pid', '', 'echo "$(date): Services started - MCP: $MCP_PID, Streamlit: $STREAMLIT_PID" >> ${LOG_DIR}/startup.log', 'echo "Services started successfully!"', 'EOL', 'chmod +x start_services_local.sh', 'chown ubuntu:ubuntu start_services_local.sh', 
        // Create systemd service
        'log "Creating systemd service"', 'cat > /etc/systemd/system/mcp-services.service << EOL', '[Unit]', 'Description=MCP Services (Local Code)', 'After=network.target', 'Wants=network-online.target', '', '[Service]', 'Type=forking', 'User=ubuntu', 'Group=ubuntu', 'Environment="HOME=/home/ubuntu"', 'Environment="PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"', 'WorkingDirectory=/home/ubuntu/demo_mcp_on_amazon_bedrock', 'ExecStart=/home/ubuntu/demo_mcp_on_amazon_bedrock/start_services_local.sh', 'Restart=always', 'RestartSec=30', 'StandardOutput=journal', 'StandardError=journal', '', '[Install]', 'WantedBy=multi-user.target', 'EOL', 
        // Enable and start service
        'log "Enabling and starting services"', 'systemctl daemon-reload', 'systemctl enable mcp-services', 'sleep 10', 'systemctl start mcp-services', 'sleep 15', 'systemctl status mcp-services >> /var/log/mcp-deployment.log 2>&1 || true', 'log "MCP deployment completed with local code"', 
        // Create health check script
        'cat > /home/ubuntu/check_services.sh << EOL', '#!/bin/bash', 'echo "=== Service Status ==="', 'systemctl status mcp-services --no-pager', 'echo "=== Process Status ==="', 'ps aux | grep -E "(python|streamlit)" | grep -v grep', 'echo "=== Port Status ==="', 'ss -tlnp | grep -E "(7002|8502)"', 'echo "=== Configuration ==="', 'cat /home/ubuntu/demo_mcp_on_amazon_bedrock/conf/config.json', 'echo "=== Recent Logs ==="', 'tail -20 /home/ubuntu/demo_mcp_on_amazon_bedrock/logs/*.log 2>/dev/null || echo "No logs found"', 'echo "=== Streamlit Health ==="', 'curl -s http://localhost:8502 > /dev/null && echo "Streamlit responding" || echo "Streamlit not responding"', 'EOL', 'chmod +x /home/ubuntu/check_services.sh', 'chown ubuntu:ubuntu /home/ubuntu/check_services.sh');
        // Create Launch Template
        const launchTemplate = new ec2.LaunchTemplate(this, `${prefix}-LaunchTemplate`, {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE),
            machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id', { os: ec2.OperatingSystemType.LINUX }),
            userData,
            role,
            securityGroup: ec2Sg,
            blockDevices: [
                {
                    deviceName: '/dev/sda1',
                    volume: {
                        ebsDevice: {
                            volumeSize: 100,
                            volumeType: ec2.EbsDeviceVolumeType.GP3,
                        }
                    }
                }
            ],
        });
        // Create Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, `${prefix}-ASG`, {
            vpc,
            launchTemplate,
            minCapacity: 1,
            maxCapacity: 1,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
            }
        });
        // Add dependency to ensure code is deployed before instances start
        asg.node.addDependency(codeDeployment);
        // Add ASG as target for ALB
        streamlitListener.addTargets('Streamlit-Target', {
            port: 8502,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [asg],
            healthCheck: {
                path: '/',
                unhealthyThresholdCount: 3,
                healthyThresholdCount: 2,
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(10),
                healthyHttpCodes: '200,302'
            }
        });
        // Stack Outputs
        new cdk.CfnOutput(this, 'StreamlitEndpoint', {
            value: `http://${alb.loadBalancerDnsName}:8502`,
            description: 'Streamlit UI Endpoint'
        });
        new cdk.CfnOutput(this, 'CodeBucket', {
            value: codeBucket.bucketName,
            description: 'S3 bucket containing the application code'
        });
        new cdk.CfnOutput(this, 'AllowedCIDR', {
            value: allowedCidr,
            description: 'CIDR block allowed to access the application'
        });
        new cdk.CfnOutput(this, 'Authentication', {
            value: 'Uses EC2 Instance Role (no API keys needed)',
            description: 'Authentication method'
        });
    }
}
exports.BedrockMcpStack = BedrockMcpStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmVkcm9jay1tY3Atc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvYmVkcm9jay1tY3Atc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsZ0VBQWdFO0FBQ2hFLDJEQUEyRDtBQUMzRCx5Q0FBeUM7QUFDekMsMERBQTBEO0FBRTFELDZCQUE2QjtBQU83QixNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QjtRQUNwRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLE1BQU0sR0FBRyxLQUFLLEVBQUUsVUFBVSxJQUFJLEtBQUssQ0FBQztRQUMxQyxNQUFNLFdBQVcsR0FBRyxZQUFZLENBQUM7UUFFakMsdUNBQXVDO1FBQ3ZDLE1BQU0sVUFBVSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsR0FBRyxNQUFNLGFBQWEsRUFBRTtZQUM3RCxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsZ0RBQWdEO1FBQ2hELE1BQU0sY0FBYyxHQUFHLElBQUksUUFBUSxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxHQUFHLE1BQU0saUJBQWlCLEVBQUU7WUFDckYsT0FBTyxFQUFFO2dCQUNQLFFBQVEsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsU0FBUyxFQUFFLFFBQVEsQ0FBQyxFQUFFO29CQUN2RCxPQUFPLEVBQUU7d0JBQ1AsR0FBRzt3QkFDSCxTQUFTO3dCQUNULFVBQVU7d0JBQ1YsYUFBYTt3QkFDYixpQkFBaUI7d0JBQ2pCLFVBQVU7d0JBQ1YsT0FBTztxQkFDUjtpQkFDRixDQUFDO2FBQ0g7WUFDRCxpQkFBaUIsRUFBRSxVQUFVO1lBQzdCLG9CQUFvQixFQUFFLFVBQVU7WUFDaEMsS0FBSyxFQUFFLEtBQUs7U0FDYixDQUFDLENBQUM7UUFFSCxhQUFhO1FBQ2IsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxHQUFHLE1BQU0sTUFBTSxFQUFFO1lBQzdDLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxtQkFBbUIsRUFBRTtnQkFDbkI7b0JBQ0UsSUFBSSxFQUFFLFFBQVE7b0JBQ2QsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsTUFBTTtvQkFDakMsUUFBUSxFQUFFLEVBQUU7aUJBQ2I7Z0JBQ0Q7b0JBQ0UsSUFBSSxFQUFFLFNBQVM7b0JBQ2YsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CO29CQUM5QyxRQUFRLEVBQUUsRUFBRTtpQkFDYjthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsZ0NBQWdDO1FBQ2hDLE1BQU0sS0FBSyxHQUFHLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsR0FBRyxNQUFNLFNBQVMsRUFBRTtZQUM1RCxHQUFHO1lBQ0gsZ0JBQWdCLEVBQUUsSUFBSTtZQUN0QixXQUFXLEVBQUUsOENBQThDO1lBQzNELGtCQUFrQixFQUFFLElBQUk7U0FDekIsQ0FBQyxDQUFDO1FBRUgsS0FBSyxDQUFDLGNBQWMsQ0FDbEIsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLEVBQzFCLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUNsQiw0QkFBNEIsV0FBVyxFQUFFLENBQzFDLENBQUM7UUFFRixnQ0FBZ0M7UUFDaEMsTUFBTSxLQUFLLEdBQUcsSUFBSSxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxHQUFHLE1BQU0sU0FBUyxFQUFFO1lBQzVELEdBQUc7WUFDSCxnQkFBZ0IsRUFBRSxJQUFJO1lBQ3RCLFdBQVcsRUFBRSxrQ0FBa0M7U0FDaEQsQ0FBQyxDQUFDO1FBRUgsS0FBSyxDQUFDLGNBQWMsQ0FDbEIsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDLGVBQWUsQ0FBQyxFQUMvQyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFDbEIsdUJBQXVCLENBQ3hCLENBQUM7UUFFRixrQkFBa0I7UUFDbEIsTUFBTSxJQUFJLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDMUMsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLG1CQUFtQixDQUFDO1lBQ3hELGVBQWUsRUFBRTtnQkFDZixHQUFHLENBQUMsYUFBYSxDQUFDLHdCQUF3QixDQUFDLDhCQUE4QixDQUFDO2FBQzNFO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsMEJBQTBCO1FBQzFCLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLHNCQUFzQjtnQkFDdEIsOEJBQThCO2FBQy9CO1lBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO1NBQ2pCLENBQUMsQ0FBQyxDQUFDO1FBRUosc0NBQXNDO1FBQ3RDLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLGNBQWM7Z0JBQ2QsZUFBZTthQUNoQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxVQUFVLENBQUMsU0FBUztnQkFDcEIsR0FBRyxVQUFVLENBQUMsU0FBUyxJQUFJO2FBQzVCO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSixtQ0FBbUM7UUFDbkMsTUFBTSxHQUFHLEdBQUcsSUFBSSxLQUFLLENBQUMsdUJBQXVCLENBQUMsSUFBSSxFQUFFLEdBQUcsTUFBTSxNQUFNLEVBQUU7WUFDbkUsR0FBRztZQUNILGNBQWMsRUFBRSxJQUFJO1lBQ3BCLGFBQWEsRUFBRSxLQUFLO1NBQ3JCLENBQUMsQ0FBQztRQUVILE1BQU0saUJBQWlCLEdBQUcsR0FBRyxDQUFDLFdBQVcsQ0FBQyxXQUFXLEVBQUU7WUFDckQsSUFBSSxFQUFFLElBQUk7WUFDVixRQUFRLEVBQUUsS0FBSyxDQUFDLG1CQUFtQixDQUFDLElBQUk7WUFDeEMsSUFBSSxFQUFFLEtBQUs7U0FDWixDQUFDLENBQUM7UUFFSCxxREFBcUQ7UUFDckQsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUN6QyxRQUFRLENBQUMsV0FBVyxDQUNsQixhQUFhLEVBQ2IsUUFBUTtRQUVSLG1CQUFtQjtRQUNuQixvRUFBb0UsRUFDcEUsK0NBQStDO1FBRS9DLDRCQUE0QjtRQUM1QixtQkFBbUIsRUFDbkIsb0NBQW9DLEVBQ3BDLHVDQUF1QztRQUV2Qyx5Q0FBeUM7UUFDekMsZ0NBQWdDLEVBQ2hDLG1CQUFtQixFQUNuQixtRkFBbUY7UUFFbkYsc0JBQXNCO1FBQ3RCLDhCQUE4QixFQUM5QiwwQ0FBMEMsRUFDMUMsbUJBQW1CLEVBQ25CLDBFQUEwRTtRQUUxRSxrQkFBa0I7UUFDbEIsMEJBQTBCLEVBQzFCLDJEQUEyRCxFQUMzRCwyQkFBMkI7UUFFM0IsOEJBQThCO1FBQzlCLHNDQUFzQyxFQUN0QyxrRkFBa0Y7UUFFbEYsZ0NBQWdDO1FBQ2hDLDBDQUEwQyxFQUMxQyxrRUFBa0UsRUFDbEUsOEVBQThFO1FBRTlFLDJCQUEyQjtRQUMzQixrQ0FBa0MsRUFDbEMsa0RBQWtELEVBQ2xELDZEQUE2RCxFQUM3RCw0Q0FBNEM7UUFFNUMsNkNBQTZDO1FBQzdDLDRDQUE0QyxFQUM1QyxvQkFBb0IsVUFBVSxDQUFDLFVBQVUsd0JBQXdCLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUM1RixnREFBZ0Q7UUFFaEQsZ0VBQWdFO1FBQ2hFLCtCQUErQixFQUMvQixzQkFBc0I7UUFFdEIsdUJBQXVCO1FBQ3ZCLGdFQUFnRSxFQUNoRSxtREFBbUQ7UUFFbkQsK0JBQStCO1FBQy9CLHNDQUFzQyxFQUN0QyxtQkFBbUIsRUFDbkIsaUNBQWlDO1FBRWpDLDZDQUE2QztRQUM3QyxzQ0FBc0MsRUFDdEMsa0VBQWtFO1FBRWxFLDJCQUEyQjtRQUMzQixxQ0FBcUMsRUFDckMsa0JBQWtCLEVBQ2xCLGtEQUFrRCxFQUNsRCxxREFBcUQsRUFDckQsZ0NBQWdDLEVBQ2hDLGlDQUFpQyxFQUNqQyxpQ0FBaUMsRUFDakMsc0JBQXNCLEVBQ3RCLGtOQUFrTixFQUNsTixHQUFHO1FBRUgsbURBQW1EO1FBQ25ELCtCQUErQixFQUMvQixtQkFBbUIsRUFDbkIsYUFBYSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sRUFDekMsZ0JBQWdCLEVBQ2hCLDJCQUEyQixFQUMzQiw0QkFBNEIsRUFDNUIsdUJBQXVCLEVBQ3ZCLG9DQUFvQyxFQUNwQyxXQUFXLEdBQUcsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQ3JDLEtBQUssRUFDTCwwQkFBMEIsRUFDMUIsZ0JBQWdCO1FBRWhCLHdCQUF3QjtRQUN4QiwrQkFBK0IsRUFDL0Isc0NBQXNDLEVBQ3RDLGFBQWEsRUFDYiw0Q0FBNEMsRUFDNUMsMkJBQTJCLEVBQzNCLHFDQUFxQyxFQUNyQyxxQ0FBcUMsRUFDckMsRUFBRSxFQUNGLDBCQUEwQixFQUMxQixxQkFBcUIsRUFDckIsRUFBRSxFQUNGLCtCQUErQixFQUMvQixvQ0FBb0MsRUFDcEMsOEJBQThCLEVBQzlCLFNBQVMsRUFDVCxFQUFFLEVBQ0YscUJBQXFCLEVBQ3JCLGdFQUFnRSxFQUNoRSw2QkFBNkIsRUFDN0Isb0NBQW9DLEVBQ3BDLDhDQUE4QyxFQUM5QyxtQ0FBbUMsRUFDbkMsbUNBQW1DLEVBQ25DLGlDQUFpQyxFQUNqQyxZQUFZLEVBQ1osb0NBQW9DLEVBQ3BDLEVBQUUsRUFDRixpQ0FBaUMsRUFDakMsVUFBVSxFQUNWLEVBQUUsRUFDRixtQ0FBbUMsRUFDbkMseUNBQXlDLEVBQ3pDLDJFQUEyRSxFQUMzRSxZQUFZLEVBQ1osSUFBSSxFQUNKLEVBQUUsRUFDRiwyQkFBMkIsRUFDM0Isc0VBQXNFLEVBQ3RFLG1DQUFtQyxFQUNuQyw4Q0FBOEMsRUFDOUMsaUNBQWlDLEVBQ2pDLCtCQUErQixFQUMvQix1Q0FBdUMsRUFDdkMsa0JBQWtCLEVBQ2xCLGdEQUFnRCxFQUNoRCxFQUFFLEVBQ0YsdUdBQXVHLEVBQ3ZHLHVDQUF1QyxFQUN2QyxLQUFLLEVBRUwsa0NBQWtDLEVBQ2xDLDZDQUE2QztRQUU3Qyx5QkFBeUI7UUFDekIsZ0NBQWdDLEVBQ2hDLHVEQUF1RCxFQUN2RCxRQUFRLEVBQ1IsdUNBQXVDLEVBQ3ZDLHNCQUFzQixFQUN0Qiw2QkFBNkIsRUFDN0IsRUFBRSxFQUNGLFdBQVcsRUFDWCxjQUFjLEVBQ2QsYUFBYSxFQUNiLGNBQWMsRUFDZCxpQ0FBaUMsRUFDakMseUdBQXlHLEVBQ3pHLDBEQUEwRCxFQUMxRCwyRUFBMkUsRUFDM0UsZ0JBQWdCLEVBQ2hCLGVBQWUsRUFDZix3QkFBd0IsRUFDeEIsdUJBQXVCLEVBQ3ZCLEVBQUUsRUFDRixXQUFXLEVBQ1gsNEJBQTRCLEVBQzVCLEtBQUs7UUFFTCwyQkFBMkI7UUFDM0Isc0NBQXNDLEVBQ3RDLHlCQUF5QixFQUN6QiwrQkFBK0IsRUFDL0IsVUFBVSxFQUNWLDhCQUE4QixFQUM5QixVQUFVLEVBQ1YsMkVBQTJFLEVBQzNFLGdEQUFnRDtRQUVoRCw2QkFBNkI7UUFDN0IsNkNBQTZDLEVBQzdDLGFBQWEsRUFDYiwrQkFBK0IsRUFDL0IsMENBQTBDLEVBQzFDLCtCQUErQixFQUMvQixzREFBc0QsRUFDdEQsNEJBQTRCLEVBQzVCLGtDQUFrQyxFQUNsQyw4QkFBOEIsRUFDOUIsOERBQThELEVBQzlELDRCQUE0QixFQUM1QixpR0FBaUcsRUFDakcsaUNBQWlDLEVBQ2pDLDZHQUE2RyxFQUM3RyxLQUFLLEVBQ0wseUNBQXlDLEVBQ3pDLG9EQUFvRCxDQUNyRCxDQUFDO1FBRUYseUJBQXlCO1FBQ3pCLE1BQU0sY0FBYyxHQUFHLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsR0FBRyxNQUFNLGlCQUFpQixFQUFFO1lBQzlFLFlBQVksRUFBRSxHQUFHLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLEVBQUUsRUFBRSxHQUFHLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQztZQUNoRixZQUFZLEVBQUUsR0FBRyxDQUFDLFlBQVksQ0FBQyxnQkFBZ0IsQ0FDN0Msb0ZBQW9GLEVBQ3BGLEVBQUUsRUFBRSxFQUFFLEdBQUcsQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLLEVBQUUsQ0FDdEM7WUFDRCxRQUFRO1lBQ1IsSUFBSTtZQUNKLGFBQWEsRUFBRSxLQUFLO1lBQ3BCLFlBQVksRUFBRTtnQkFDWjtvQkFDRSxVQUFVLEVBQUUsV0FBVztvQkFDdkIsTUFBTSxFQUFFO3dCQUNOLFNBQVMsRUFBRTs0QkFDVCxVQUFVLEVBQUUsR0FBRzs0QkFDZixVQUFVLEVBQUUsR0FBRyxDQUFDLG1CQUFtQixDQUFDLEdBQUc7eUJBQ3hDO3FCQUNGO2lCQUNGO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCw0QkFBNEI7UUFDNUIsTUFBTSxHQUFHLEdBQUcsSUFBSSxXQUFXLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLEdBQUcsTUFBTSxNQUFNLEVBQUU7WUFDbEUsR0FBRztZQUNILGNBQWM7WUFDZCxXQUFXLEVBQUUsQ0FBQztZQUNkLFdBQVcsRUFBRSxDQUFDO1lBQ2QsVUFBVSxFQUFFO2dCQUNWLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLG1CQUFtQjthQUMvQztTQUNGLENBQUMsQ0FBQztRQUVILG1FQUFtRTtRQUNuRSxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUV2Qyw0QkFBNEI7UUFDNUIsaUJBQWlCLENBQUMsVUFBVSxDQUFDLGtCQUFrQixFQUFFO1lBQy9DLElBQUksRUFBRSxJQUFJO1lBQ1YsUUFBUSxFQUFFLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJO1lBQ3hDLE9BQU8sRUFBRSxDQUFDLEdBQUcsQ0FBQztZQUNkLFdBQVcsRUFBRTtnQkFDWCxJQUFJLEVBQUUsR0FBRztnQkFDVCx1QkFBdUIsRUFBRSxDQUFDO2dCQUMxQixxQkFBcUIsRUFBRSxDQUFDO2dCQUN4QixRQUFRLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO2dCQUNsQyxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO2dCQUNqQyxnQkFBZ0IsRUFBRSxTQUFTO2FBQzVCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsZ0JBQWdCO1FBQ2hCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDM0MsS0FBSyxFQUFFLFVBQVUsR0FBRyxDQUFDLG1CQUFtQixPQUFPO1lBQy9DLFdBQVcsRUFBRSx1QkFBdUI7U0FDckMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDcEMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxVQUFVO1lBQzVCLFdBQVcsRUFBRSwyQ0FBMkM7U0FDekQsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDckMsS0FBSyxFQUFFLFdBQVc7WUFDbEIsV0FBVyxFQUFFLDhDQUE4QztTQUM1RCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hDLEtBQUssRUFBRSw2Q0FBNkM7WUFDcEQsV0FBVyxFQUFFLHVCQUF1QjtTQUNyQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUE5WUQsMENBOFlDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hdXRvc2NhbGluZyc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnQnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEJlZHJvY2tNY3BTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBuYW1lUHJlZml4Pzogc3RyaW5nO1xuICBhbGxvd2VkQ2lkcj86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEJlZHJvY2tNY3BTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogQmVkcm9ja01jcFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IHByZWZpeCA9IHByb3BzPy5uYW1lUHJlZml4IHx8ICdNQ1AnO1xuICAgIGNvbnN0IGFsbG93ZWRDaWRyID0gJzQuMC4wLjAvMjMnO1xuXG4gICAgLy8gQ3JlYXRlIFMzIGJ1Y2tldCBmb3IgY29kZSBkZXBsb3ltZW50XG4gICAgY29uc3QgY29kZUJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgYCR7cHJlZml4fS1Db2RlQnVja2V0YCwge1xuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gRGVwbG95IG9ubHkgZXNzZW50aWFsIGFwcGxpY2F0aW9uIGZpbGVzIHRvIFMzXG4gICAgY29uc3QgY29kZURlcGxveW1lbnQgPSBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCBgJHtwcmVmaXh9LUNvZGVEZXBsb3ltZW50YCwge1xuICAgICAgc291cmNlczogW1xuICAgICAgICBzM2RlcGxveS5Tb3VyY2UuYXNzZXQocGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4uLy4uLycpLCB7XG4gICAgICAgICAgZXhjbHVkZTogW1xuICAgICAgICAgICAgJyonLFxuICAgICAgICAgICAgJyFzcmMvKionLFxuICAgICAgICAgICAgJyFjb25mLyoqJyxcbiAgICAgICAgICAgICchY2hhdGJvdC5weScsXG4gICAgICAgICAgICAnIXB5cHJvamVjdC50b21sJyxcbiAgICAgICAgICAgICchdXYubG9jaycsXG4gICAgICAgICAgICAnIS5lbnYnXG4gICAgICAgICAgXVxuICAgICAgICB9KVxuICAgICAgXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiBjb2RlQnVja2V0LFxuICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6ICdtY3AtYXBwLycsXG4gICAgICBwcnVuZTogZmFsc2VcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBWUENcbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCBgJHtwcmVmaXh9LVZQQ2AsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1B1YmxpYycsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDLFxuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdQcml2YXRlJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLFxuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgfVxuICAgICAgXVxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIFNlY3VyaXR5IEdyb3VwIGZvciBBTEJcbiAgICBjb25zdCBhbGJTZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCBgJHtwcmVmaXh9LUFMQi1TR2AsIHtcbiAgICAgIHZwYyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyJyxcbiAgICAgIGRpc2FibGVJbmxpbmVSdWxlczogdHJ1ZVxuICAgIH0pO1xuXG4gICAgYWxiU2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICBlYzIuUGVlci5pcHY0KGFsbG93ZWRDaWRyKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg4NTAyKSxcbiAgICAgIGBTdHJlYW1saXQgVUkgYWNjZXNzIGZyb20gJHthbGxvd2VkQ2lkcn1gXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBTZWN1cml0eSBHcm91cCBmb3IgRUMyXG4gICAgY29uc3QgZWMyU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgYCR7cHJlZml4fS1FQzItU0dgLCB7XG4gICAgICB2cGMsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWN1cml0eSBncm91cCBmb3IgRUMyIGluc3RhbmNlcydcbiAgICB9KTtcblxuICAgIGVjMlNnLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKGFsYlNnLnNlY3VyaXR5R3JvdXBJZCksXG4gICAgICBlYzIuUG9ydC50Y3AoODUwMiksXG4gICAgICAnU3RyZWFtbGl0IFVJIGZyb20gQUxCJ1xuICAgICk7XG5cbiAgICAvLyBDcmVhdGUgSUFNIFJvbGVcbiAgICBjb25zdCByb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFQzItUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlYzIuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnQW1hem9uU1NNTWFuYWdlZEluc3RhbmNlQ29yZScpXG4gICAgICBdXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgQmVkcm9jayBwZXJtaXNzaW9uc1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbConLFxuICAgICAgICAnYmVkcm9jazpMaXN0Rm91bmRhdGlvbk1vZGVscydcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddXG4gICAgfSkpO1xuXG4gICAgLy8gQWRkIFMzIHBlcm1pc3Npb25zIHRvIGRvd25sb2FkIGNvZGVcbiAgICByb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3MzOkdldE9iamVjdCcsXG4gICAgICAgICdzMzpMaXN0QnVja2V0J1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBjb2RlQnVja2V0LmJ1Y2tldEFybixcbiAgICAgICAgYCR7Y29kZUJ1Y2tldC5idWNrZXRBcm59LypgXG4gICAgICBdXG4gICAgfSkpO1xuXG4gICAgLy8gQ3JlYXRlIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICBjb25zdCBhbGIgPSBuZXcgZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIodGhpcywgYCR7cHJlZml4fS1BTEJgLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGFsYlNnXG4gICAgfSk7XG5cbiAgICBjb25zdCBzdHJlYW1saXRMaXN0ZW5lciA9IGFsYi5hZGRMaXN0ZW5lcignU3RyZWFtbGl0JywgeyBcbiAgICAgIHBvcnQ6IDg1MDIsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgb3BlbjogZmFsc2VcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBVc2VyIERhdGEgdGhhdCBkb3dubG9hZHMgbG9jYWwgY29kZSBmcm9tIFMzXG4gICAgY29uc3QgdXNlckRhdGEgPSBlYzIuVXNlckRhdGEuZm9yTGludXgoKTtcbiAgICB1c2VyRGF0YS5hZGRDb21tYW5kcyhcbiAgICAgICcjIS9iaW4vYmFzaCcsXG4gICAgICAnc2V0IC1lJyxcbiAgICAgIFxuICAgICAgLy8gTG9nZ2luZyBmdW5jdGlvblxuICAgICAgJ2xvZygpIHsgZWNobyBcIiQoZGF0ZSk6ICQxXCIgfCB0ZWUgLWEgL3Zhci9sb2cvbWNwLWRlcGxveW1lbnQubG9nOyB9JyxcbiAgICAgICdsb2cgXCJTdGFydGluZyBNQ1AgZGVwbG95bWVudCB3aXRoIGxvY2FsIGNvZGVcIicsXG4gICAgICBcbiAgICAgIC8vIFNldCBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICAgICdleHBvcnQgSE9NRT0vcm9vdCcsXG4gICAgICAnZXhwb3J0IFBBVEg9XCIvdXNyL2xvY2FsL2JpbjokUEFUSFwiJyxcbiAgICAgICdleHBvcnQgREVCSUFOX0ZST05URU5EPW5vbmludGVyYWN0aXZlJyxcbiAgICAgIFxuICAgICAgLy8gVXBkYXRlIHN5c3RlbSBhbmQgaW5zdGFsbCBkZXBlbmRlbmNpZXNcbiAgICAgICdsb2cgXCJVcGRhdGluZyBzeXN0ZW0gcGFja2FnZXNcIicsXG4gICAgICAnYXB0LWdldCB1cGRhdGUgLXknLFxuICAgICAgJ2FwdC1nZXQgaW5zdGFsbCAteSBzb2Z0d2FyZS1wcm9wZXJ0aWVzLWNvbW1vbiBjdXJsIHdnZXQgZ2l0IGJ1aWxkLWVzc2VudGlhbCB1bnppcCcsXG4gICAgICBcbiAgICAgIC8vIEluc3RhbGwgUHl0aG9uIDMuMTJcbiAgICAgICdsb2cgXCJJbnN0YWxsaW5nIFB5dGhvbiAzLjEyXCInLFxuICAgICAgJ2FkZC1hcHQtcmVwb3NpdG9yeSAteSBwcGE6ZGVhZHNuYWtlcy9wcGEnLFxuICAgICAgJ2FwdC1nZXQgdXBkYXRlIC15JyxcbiAgICAgICdhcHQtZ2V0IGluc3RhbGwgLXkgcHl0aG9uMy4xMiBweXRob24zLjEyLXZlbnYgcHl0aG9uMy4xMi1kZXYgcHl0aG9uMy1waXAnLFxuICAgICAgXG4gICAgICAvLyBJbnN0YWxsIE5vZGUuanNcbiAgICAgICdsb2cgXCJJbnN0YWxsaW5nIE5vZGUuanNcIicsXG4gICAgICAnY3VybCAtZnNTTCBodHRwczovL2RlYi5ub2Rlc291cmNlLmNvbS9zZXR1cF8yMi54IHwgYmFzaCAtJyxcbiAgICAgICdhcHQtZ2V0IGluc3RhbGwgLXkgbm9kZWpzJyxcbiAgICAgIFxuICAgICAgLy8gSW5zdGFsbCBzeXN0ZW0gZGVwZW5kZW5jaWVzXG4gICAgICAnbG9nIFwiSW5zdGFsbGluZyBzeXN0ZW0gZGVwZW5kZW5jaWVzXCInLFxuICAgICAgJ2FwdC1nZXQgaW5zdGFsbCAteSBwb3J0YXVkaW8xOS1kZXYgbGliYXNvdW5kMi1kZXYgbGlicG9ydGF1ZGlvMiBsaWJwb3J0YXVkaW9jcHAwJyxcbiAgICAgIFxuICAgICAgLy8gU2V0dXAgdWJ1bnR1IHVzZXIgZW52aXJvbm1lbnRcbiAgICAgICdsb2cgXCJTZXR0aW5nIHVwIHVidW50dSB1c2VyIGVudmlyb25tZW50XCInLFxuICAgICAgJ3N1IC0gdWJ1bnR1IC1jIFwiY3VybCAtTHNTZiBodHRwczovL2FzdHJhbC5zaC91di9pbnN0YWxsLnNoIHwgc2hcIicsXG4gICAgICAnZWNobyBcXCdleHBvcnQgUEFUSD1cIi9ob21lL3VidW50dS8ubG9jYWwvYmluOiRQQVRIXCJcXCcgPj4gL2hvbWUvdWJ1bnR1Ly5iYXNocmMnLFxuICAgICAgXG4gICAgICAvLyBDcmVhdGUgcHJvamVjdCBkaXJlY3RvcnlcbiAgICAgICdsb2cgXCJDcmVhdGluZyBwcm9qZWN0IGRpcmVjdG9yeVwiJyxcbiAgICAgICdta2RpciAtcCAvaG9tZS91YnVudHUvZGVtb19tY3Bfb25fYW1hem9uX2JlZHJvY2snLFxuICAgICAgJ2Nob3duIHVidW50dTp1YnVudHUgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdjZCAvaG9tZS91YnVudHUvZGVtb19tY3Bfb25fYW1hem9uX2JlZHJvY2snLFxuICAgICAgXG4gICAgICAvLyBEb3dubG9hZCBjb2RlIGZyb20gUzMgaW5zdGVhZCBvZiBnaXQgY2xvbmVcbiAgICAgICdsb2cgXCJEb3dubG9hZGluZyBhcHBsaWNhdGlvbiBjb2RlIGZyb20gUzNcIicsXG4gICAgICBgYXdzIHMzIHN5bmMgczM6Ly8ke2NvZGVCdWNrZXQuYnVja2V0TmFtZX0vbWNwLWFwcC8gLiAtLXJlZ2lvbiAke2Nkay5TdGFjay5vZih0aGlzKS5yZWdpb259YCxcbiAgICAgICdsb2cgXCJBcHBsaWNhdGlvbiBjb2RlIGRvd25sb2FkZWQgc3VjY2Vzc2Z1bGx5XCInLFxuICAgICAgXG4gICAgICAvLyBWZXJpZnkgd2UgaGF2ZSB0aGUgY29ycmVjdCBjb25maWcgKHNob3VsZCBvbmx5IGhhdmUgTm92YSBQcm8pXG4gICAgICAnbG9nIFwiVmVyaWZ5aW5nIGNvbmZpZ3VyYXRpb25cIicsXG4gICAgICAnY2F0IGNvbmYvY29uZmlnLmpzb24nLFxuICAgICAgXG4gICAgICAvLyBTZXQgcHJvcGVyIG93bmVyc2hpcFxuICAgICAgJ2Nob3duIC1SIHVidW50dTp1YnVudHUgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdjaG1vZCA3NTUgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgIFxuICAgICAgLy8gQ3JlYXRlIG5lY2Vzc2FyeSBkaXJlY3Rvcmllc1xuICAgICAgJ2xvZyBcIkNyZWF0aW5nIG5lY2Vzc2FyeSBkaXJlY3Rvcmllc1wiJyxcbiAgICAgICdta2RpciAtcCBsb2dzIHRtcCcsXG4gICAgICAnY2hvd24gLVIgdWJ1bnR1OnVidW50dSBsb2dzIHRtcCcsXG4gICAgICBcbiAgICAgIC8vIFJlbW92ZSBOb3ZhIFNvbmljIGNvbXBvbmVudHMgaWYgdGhleSBleGlzdFxuICAgICAgJ2xvZyBcIlJlbW92aW5nIE5vdmEgU29uaWMgY29tcG9uZW50c1wiJyxcbiAgICAgICdybSAtZiBzcmMvbm92YV9zb25pY19tYW5hZ2VyLnB5IHNyYy93ZWJzb2NrZXRfbWFuYWdlci5weSB8fCB0cnVlJyxcbiAgICAgIFxuICAgICAgLy8gU2V0dXAgUHl0aG9uIGVudmlyb25tZW50XG4gICAgICAnbG9nIFwiU2V0dGluZyB1cCBQeXRob24gZW52aXJvbm1lbnRcIicsXG4gICAgICAnc3UgLSB1YnVudHUgLWMgXCInLFxuICAgICAgJ2NkIC9ob21lL3VidW50dS9kZW1vX21jcF9vbl9hbWF6b25fYmVkcm9jayAmJiBcXFxcJyxcbiAgICAgICdleHBvcnQgUEFUSD1cXFwiL2hvbWUvdWJ1bnR1Ly5sb2NhbC9iaW46JFBBVEhcXFwiICYmIFxcXFwnLFxuICAgICAgJ3B5dGhvbjMuMTIgLW0gdmVudiAudmVudiAmJiBcXFxcJyxcbiAgICAgICdzb3VyY2UgLnZlbnYvYmluL2FjdGl2YXRlICYmIFxcXFwnLFxuICAgICAgJ3BpcCBpbnN0YWxsIC0tdXBncmFkZSBwaXAgJiYgXFxcXCcsXG4gICAgICAncGlwIGluc3RhbGwgdXYgJiYgXFxcXCcsXG4gICAgICAndXYgc3luYyAtLW5vLWRldiB8fCBwaXAgaW5zdGFsbCBib3RvMyBib3RvY29yZSBmYXN0YXBpIHV2aWNvcm4gbWNwIG9wZW5haSBhaW9odHRwIHB5dGhvbi1kb3RlbnYgcmVxdWVzdHMgcGFuZGFzIHB5dHogcnggc3RyZWFtbGl0IHN0cmVhbWxpdC1jb29raWVzLWNvbnRyb2xsZXIgc3RyZWFtbGl0LWxvY2FsLXN0b3JhZ2UgdHpkYXRhIHV2aWNvcm4gd2Vic29ja2V0cycsXG4gICAgICAnXCInLFxuICAgICAgXG4gICAgICAvLyBDb25maWd1cmUgZW52aXJvbm1lbnQgKHVzaW5nIGluc3RhbmNlIHJvbGUgb25seSlcbiAgICAgICdsb2cgXCJDb25maWd1cmluZyBlbnZpcm9ubWVudFwiJyxcbiAgICAgICdjYXQgPiAuZW52IDw8IEVPTCcsXG4gICAgICAnQVdTX1JFR0lPTj0nICsgY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgICdMT0dfRElSPS4vbG9ncycsXG4gICAgICAnQ0hBVEJPVF9TRVJWSUNFX1BPUlQ9ODUwMicsXG4gICAgICAnTUNQX1NFUlZJQ0VfSE9TVD0xMjcuMC4wLjEnLFxuICAgICAgJ01DUF9TRVJWSUNFX1BPUlQ9NzAwMicsXG4gICAgICAnTUNQX0JBU0VfVVJMPWh0dHA6Ly8xMjcuMC4wLjE6NzAwMicsXG4gICAgICBgQVBJX0tFWT0ke2Nkay5OYW1lcy51bmlxdWVJZCh0aGlzKX1gLFxuICAgICAgJ0VPTCcsXG4gICAgICAnY2hvd24gdWJ1bnR1OnVidW50dSAuZW52JyxcbiAgICAgICdjaG1vZCA2MDAgLmVudicsXG4gICAgICBcbiAgICAgIC8vIENyZWF0ZSBzdGFydHVwIHNjcmlwdFxuICAgICAgJ2xvZyBcIkNyZWF0aW5nIHN0YXJ0dXAgc2NyaXB0XCInLFxuICAgICAgJ2NhdCA+IHN0YXJ0X3NlcnZpY2VzX2xvY2FsLnNoIDw8IEVPTCcsXG4gICAgICAnIyEvYmluL2Jhc2gnLFxuICAgICAgJ2NkIC9ob21lL3VidW50dS9kZW1vX21jcF9vbl9hbWF6b25fYmVkcm9jaycsXG4gICAgICAnc291cmNlIC52ZW52L2Jpbi9hY3RpdmF0ZScsXG4gICAgICAnZXhwb3J0ICQoZ3JlcCAtdiBcIl4jXCIgLmVudiB8IHhhcmdzKScsXG4gICAgICAnZXhwb3J0IFBZVEhPTlBBVEg9Li9zcmM6JFBZVEhPTlBBVEgnLFxuICAgICAgJycsXG4gICAgICAnIyBDcmVhdGUgbG9nIGRpcmVjdG9yaWVzJyxcbiAgICAgICdta2RpciAtcCAke0xPR19ESVJ9JyxcbiAgICAgICcnLFxuICAgICAgJyMgS2lsbCBhbnkgZXhpc3RpbmcgcHJvY2Vzc2VzJyxcbiAgICAgICdwa2lsbCAtZiBcInB5dGhvbi4qbWFpbi5weVwiIHx8IHRydWUnLFxuICAgICAgJ3BraWxsIC1mIFwic3RyZWFtbGl0XCIgfHwgdHJ1ZScsXG4gICAgICAnc2xlZXAgMycsXG4gICAgICAnJyxcbiAgICAgICcjIFN0YXJ0IE1DUCBzZXJ2aWNlJyxcbiAgICAgICdlY2hvIFwiJChkYXRlKTogU3RhcnRpbmcgTUNQIHNlcnZpY2VcIiA+PiAke0xPR19ESVJ9L3N0YXJ0dXAubG9nJyxcbiAgICAgICdub2h1cCBweXRob24gc3JjL21haW4ucHkgXFxcXCcsXG4gICAgICAnICAgIC0tbWNwLWNvbmYgY29uZi9jb25maWcuanNvbiBcXFxcJyxcbiAgICAgICcgICAgLS11c2VyLWNvbmYgY29uZi91c2VyX21jcF9jb25maWcuanNvbiBcXFxcJyxcbiAgICAgICcgICAgLS1ob3N0ICR7TUNQX1NFUlZJQ0VfSE9TVH0gXFxcXCcsXG4gICAgICAnICAgIC0tcG9ydCAke01DUF9TRVJWSUNFX1BPUlR9IFxcXFwnLFxuICAgICAgJyAgICA+ICR7TE9HX0RJUn0vbWNwLmxvZyAyPiYxICYnLFxuICAgICAgJ01DUF9QSUQ9JCEnLFxuICAgICAgJ2VjaG8gJE1DUF9QSUQgPiAke0xPR19ESVJ9L21jcC5waWQnLFxuICAgICAgJycsXG4gICAgICAnIyBXYWl0IGZvciBNQ1Agc2VydmljZSB0byBzdGFydCcsXG4gICAgICAnc2xlZXAgMTUnLFxuICAgICAgJycsXG4gICAgICAnIyBDaGVjayBpZiBNQ1Agc2VydmljZSBpcyBydW5uaW5nJyxcbiAgICAgICdpZiAhIGtpbGwgLTAgJE1DUF9QSUQgMj4vZGV2L251bGw7IHRoZW4nLFxuICAgICAgJyAgICBlY2hvIFwiJChkYXRlKTogTUNQIHNlcnZpY2UgZmFpbGVkIHRvIHN0YXJ0XCIgPj4gJHtMT0dfRElSfS9zdGFydHVwLmxvZycsXG4gICAgICAnICAgIGV4aXQgMScsXG4gICAgICAnZmknLFxuICAgICAgJycsXG4gICAgICAnIyBTdGFydCBTdHJlYW1saXQgc2VydmljZScsXG4gICAgICAnZWNobyBcIiQoZGF0ZSk6IFN0YXJ0aW5nIFN0cmVhbWxpdCBzZXJ2aWNlXCIgPj4gJHtMT0dfRElSfS9zdGFydHVwLmxvZycsXG4gICAgICAnbm9odXAgc3RyZWFtbGl0IHJ1biBjaGF0Ym90LnB5IFxcXFwnLFxuICAgICAgJyAgICAtLXNlcnZlci5wb3J0ICR7Q0hBVEJPVF9TRVJWSUNFX1BPUlR9IFxcXFwnLFxuICAgICAgJyAgICAtLXNlcnZlci5hZGRyZXNzIDAuMC4wLjAgXFxcXCcsXG4gICAgICAnICAgIC0tc2VydmVyLmhlYWRsZXNzIHRydWUgXFxcXCcsXG4gICAgICAnICAgID4gJHtMT0dfRElSfS9zdHJlYW1saXQubG9nIDI+JjEgJicsXG4gICAgICAnU1RSRUFNTElUX1BJRD0kIScsXG4gICAgICAnZWNobyAkU1RSRUFNTElUX1BJRCA+ICR7TE9HX0RJUn0vc3RyZWFtbGl0LnBpZCcsXG4gICAgICAnJyxcbiAgICAgICdlY2hvIFwiJChkYXRlKTogU2VydmljZXMgc3RhcnRlZCAtIE1DUDogJE1DUF9QSUQsIFN0cmVhbWxpdDogJFNUUkVBTUxJVF9QSURcIiA+PiAke0xPR19ESVJ9L3N0YXJ0dXAubG9nJyxcbiAgICAgICdlY2hvIFwiU2VydmljZXMgc3RhcnRlZCBzdWNjZXNzZnVsbHkhXCInLFxuICAgICAgJ0VPTCcsXG4gICAgICBcbiAgICAgICdjaG1vZCAreCBzdGFydF9zZXJ2aWNlc19sb2NhbC5zaCcsXG4gICAgICAnY2hvd24gdWJ1bnR1OnVidW50dSBzdGFydF9zZXJ2aWNlc19sb2NhbC5zaCcsXG4gICAgICBcbiAgICAgIC8vIENyZWF0ZSBzeXN0ZW1kIHNlcnZpY2VcbiAgICAgICdsb2cgXCJDcmVhdGluZyBzeXN0ZW1kIHNlcnZpY2VcIicsXG4gICAgICAnY2F0ID4gL2V0Yy9zeXN0ZW1kL3N5c3RlbS9tY3Atc2VydmljZXMuc2VydmljZSA8PCBFT0wnLFxuICAgICAgJ1tVbml0XScsXG4gICAgICAnRGVzY3JpcHRpb249TUNQIFNlcnZpY2VzIChMb2NhbCBDb2RlKScsXG4gICAgICAnQWZ0ZXI9bmV0d29yay50YXJnZXQnLFxuICAgICAgJ1dhbnRzPW5ldHdvcmstb25saW5lLnRhcmdldCcsXG4gICAgICAnJyxcbiAgICAgICdbU2VydmljZV0nLFxuICAgICAgJ1R5cGU9Zm9ya2luZycsXG4gICAgICAnVXNlcj11YnVudHUnLFxuICAgICAgJ0dyb3VwPXVidW50dScsXG4gICAgICAnRW52aXJvbm1lbnQ9XCJIT01FPS9ob21lL3VidW50dVwiJyxcbiAgICAgICdFbnZpcm9ubWVudD1cIlBBVEg9L2hvbWUvdWJ1bnR1Ly5sb2NhbC9iaW46L3Vzci9sb2NhbC9zYmluOi91c3IvbG9jYWwvYmluOi91c3Ivc2JpbjovdXNyL2Jpbjovc2JpbjovYmluXCInLFxuICAgICAgJ1dvcmtpbmdEaXJlY3Rvcnk9L2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdFeGVjU3RhcnQ9L2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrL3N0YXJ0X3NlcnZpY2VzX2xvY2FsLnNoJyxcbiAgICAgICdSZXN0YXJ0PWFsd2F5cycsXG4gICAgICAnUmVzdGFydFNlYz0zMCcsXG4gICAgICAnU3RhbmRhcmRPdXRwdXQ9am91cm5hbCcsXG4gICAgICAnU3RhbmRhcmRFcnJvcj1qb3VybmFsJyxcbiAgICAgICcnLFxuICAgICAgJ1tJbnN0YWxsXScsXG4gICAgICAnV2FudGVkQnk9bXVsdGktdXNlci50YXJnZXQnLFxuICAgICAgJ0VPTCcsXG4gICAgICBcbiAgICAgIC8vIEVuYWJsZSBhbmQgc3RhcnQgc2VydmljZVxuICAgICAgJ2xvZyBcIkVuYWJsaW5nIGFuZCBzdGFydGluZyBzZXJ2aWNlc1wiJyxcbiAgICAgICdzeXN0ZW1jdGwgZGFlbW9uLXJlbG9hZCcsXG4gICAgICAnc3lzdGVtY3RsIGVuYWJsZSBtY3Atc2VydmljZXMnLFxuICAgICAgJ3NsZWVwIDEwJyxcbiAgICAgICdzeXN0ZW1jdGwgc3RhcnQgbWNwLXNlcnZpY2VzJyxcbiAgICAgICdzbGVlcCAxNScsXG4gICAgICAnc3lzdGVtY3RsIHN0YXR1cyBtY3Atc2VydmljZXMgPj4gL3Zhci9sb2cvbWNwLWRlcGxveW1lbnQubG9nIDI+JjEgfHwgdHJ1ZScsXG4gICAgICAnbG9nIFwiTUNQIGRlcGxveW1lbnQgY29tcGxldGVkIHdpdGggbG9jYWwgY29kZVwiJyxcbiAgICAgIFxuICAgICAgLy8gQ3JlYXRlIGhlYWx0aCBjaGVjayBzY3JpcHRcbiAgICAgICdjYXQgPiAvaG9tZS91YnVudHUvY2hlY2tfc2VydmljZXMuc2ggPDwgRU9MJyxcbiAgICAgICcjIS9iaW4vYmFzaCcsXG4gICAgICAnZWNobyBcIj09PSBTZXJ2aWNlIFN0YXR1cyA9PT1cIicsXG4gICAgICAnc3lzdGVtY3RsIHN0YXR1cyBtY3Atc2VydmljZXMgLS1uby1wYWdlcicsXG4gICAgICAnZWNobyBcIj09PSBQcm9jZXNzIFN0YXR1cyA9PT1cIicsXG4gICAgICAncHMgYXV4IHwgZ3JlcCAtRSBcIihweXRob258c3RyZWFtbGl0KVwiIHwgZ3JlcCAtdiBncmVwJyxcbiAgICAgICdlY2hvIFwiPT09IFBvcnQgU3RhdHVzID09PVwiJyxcbiAgICAgICdzcyAtdGxucCB8IGdyZXAgLUUgXCIoNzAwMnw4NTAyKVwiJyxcbiAgICAgICdlY2hvIFwiPT09IENvbmZpZ3VyYXRpb24gPT09XCInLFxuICAgICAgJ2NhdCAvaG9tZS91YnVudHUvZGVtb19tY3Bfb25fYW1hem9uX2JlZHJvY2svY29uZi9jb25maWcuanNvbicsXG4gICAgICAnZWNobyBcIj09PSBSZWNlbnQgTG9ncyA9PT1cIicsXG4gICAgICAndGFpbCAtMjAgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrL2xvZ3MvKi5sb2cgMj4vZGV2L251bGwgfHwgZWNobyBcIk5vIGxvZ3MgZm91bmRcIicsXG4gICAgICAnZWNobyBcIj09PSBTdHJlYW1saXQgSGVhbHRoID09PVwiJyxcbiAgICAgICdjdXJsIC1zIGh0dHA6Ly9sb2NhbGhvc3Q6ODUwMiA+IC9kZXYvbnVsbCAmJiBlY2hvIFwiU3RyZWFtbGl0IHJlc3BvbmRpbmdcIiB8fCBlY2hvIFwiU3RyZWFtbGl0IG5vdCByZXNwb25kaW5nXCInLFxuICAgICAgJ0VPTCcsXG4gICAgICAnY2htb2QgK3ggL2hvbWUvdWJ1bnR1L2NoZWNrX3NlcnZpY2VzLnNoJyxcbiAgICAgICdjaG93biB1YnVudHU6dWJ1bnR1IC9ob21lL3VidW50dS9jaGVja19zZXJ2aWNlcy5zaCdcbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIExhdW5jaCBUZW1wbGF0ZVxuICAgIGNvbnN0IGxhdW5jaFRlbXBsYXRlID0gbmV3IGVjMi5MYXVuY2hUZW1wbGF0ZSh0aGlzLCBgJHtwcmVmaXh9LUxhdW5jaFRlbXBsYXRlYCwge1xuICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLkM1LCBlYzIuSW5zdGFuY2VTaXplLlhMQVJHRSksXG4gICAgICBtYWNoaW5lSW1hZ2U6IGVjMi5NYWNoaW5lSW1hZ2UuZnJvbVNzbVBhcmFtZXRlcihcbiAgICAgICAgJy9hd3Mvc2VydmljZS9jYW5vbmljYWwvdWJ1bnR1L3NlcnZlci8yMi4wNC9zdGFibGUvY3VycmVudC9hbWQ2NC9odm0vZWJzLWdwMi9hbWktaWQnLFxuICAgICAgICB7IG9zOiBlYzIuT3BlcmF0aW5nU3lzdGVtVHlwZS5MSU5VWCB9XG4gICAgICApLFxuICAgICAgdXNlckRhdGEsXG4gICAgICByb2xlLFxuICAgICAgc2VjdXJpdHlHcm91cDogZWMyU2csXG4gICAgICBibG9ja0RldmljZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGRldmljZU5hbWU6ICcvZGV2L3NkYTEnLFxuICAgICAgICAgIHZvbHVtZToge1xuICAgICAgICAgICAgZWJzRGV2aWNlOiB7XG4gICAgICAgICAgICAgIHZvbHVtZVNpemU6IDEwMCxcbiAgICAgICAgICAgICAgdm9sdW1lVHlwZTogZWMyLkVic0RldmljZVZvbHVtZVR5cGUuR1AzLFxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgXSxcbiAgICB9KTtcbiAgICBcbiAgICAvLyBDcmVhdGUgQXV0byBTY2FsaW5nIEdyb3VwXG4gICAgY29uc3QgYXNnID0gbmV3IGF1dG9zY2FsaW5nLkF1dG9TY2FsaW5nR3JvdXAodGhpcywgYCR7cHJlZml4fS1BU0dgLCB7XG4gICAgICB2cGMsXG4gICAgICBsYXVuY2hUZW1wbGF0ZSxcbiAgICAgIG1pbkNhcGFjaXR5OiAxLFxuICAgICAgbWF4Q2FwYWNpdHk6IDEsXG4gICAgICB2cGNTdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1NcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIEFkZCBkZXBlbmRlbmN5IHRvIGVuc3VyZSBjb2RlIGlzIGRlcGxveWVkIGJlZm9yZSBpbnN0YW5jZXMgc3RhcnRcbiAgICBhc2cubm9kZS5hZGREZXBlbmRlbmN5KGNvZGVEZXBsb3ltZW50KTtcblxuICAgIC8vIEFkZCBBU0cgYXMgdGFyZ2V0IGZvciBBTEJcbiAgICBzdHJlYW1saXRMaXN0ZW5lci5hZGRUYXJnZXRzKCdTdHJlYW1saXQtVGFyZ2V0Jywge1xuICAgICAgcG9ydDogODUwMixcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICB0YXJnZXRzOiBbYXNnXSxcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIHBhdGg6ICcvJyxcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDMsXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwLDMwMidcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIFN0YWNrIE91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU3RyZWFtbGl0RW5kcG9pbnQnLCB7XG4gICAgICB2YWx1ZTogYGh0dHA6Ly8ke2FsYi5sb2FkQmFsYW5jZXJEbnNOYW1lfTo4NTAyYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3RyZWFtbGl0IFVJIEVuZHBvaW50J1xuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NvZGVCdWNrZXQnLCB7XG4gICAgICB2YWx1ZTogY29kZUJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTMyBidWNrZXQgY29udGFpbmluZyB0aGUgYXBwbGljYXRpb24gY29kZSdcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGxvd2VkQ0lEUicsIHtcbiAgICAgIHZhbHVlOiBhbGxvd2VkQ2lkcixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ0lEUiBibG9jayBhbGxvd2VkIHRvIGFjY2VzcyB0aGUgYXBwbGljYXRpb24nXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXV0aGVudGljYXRpb24nLCB7XG4gICAgICB2YWx1ZTogJ1VzZXMgRUMyIEluc3RhbmNlIFJvbGUgKG5vIEFQSSBrZXlzIG5lZWRlZCknLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXRoZW50aWNhdGlvbiBtZXRob2QnXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==