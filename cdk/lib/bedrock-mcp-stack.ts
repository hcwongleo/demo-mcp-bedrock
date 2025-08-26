import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';

export interface BedrockMcpStackProps extends cdk.StackProps {
  namePrefix?: string;
  allowedCidr?: string;
}

export class BedrockMcpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BedrockMcpStackProps) {
    super(scope, id, props);

    const prefix = props?.namePrefix || 'MCP';
    const allowedCidr = '4.0.0.0/23';

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

    albSg.addIngressRule(
      ec2.Peer.ipv4(allowedCidr),
      ec2.Port.tcp(8502),
      `Streamlit UI access from ${allowedCidr}`
    );

    // Create Security Group for EC2
    const ec2Sg = new ec2.SecurityGroup(this, `${prefix}-EC2-SG`, {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for EC2 instances'
    });

    ec2Sg.addIngressRule(
      ec2.Peer.securityGroupId(albSg.securityGroupId),
      ec2.Port.tcp(8502),
      'Streamlit UI from ALB'
    );

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
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      
      // Logging function
      'log() { echo "$(date): $1" | tee -a /var/log/mcp-deployment.log; }',
      'log "Starting MCP deployment with local code"',
      
      // Set environment variables
      'export HOME=/root',
      'export PATH="/usr/local/bin:$PATH"',
      'export DEBIAN_FRONTEND=noninteractive',
      
      // Update system and install dependencies
      'log "Updating system packages"',
      'apt-get update -y',
      'apt-get install -y software-properties-common curl wget git build-essential unzip',
      
      // Install AWS CLI first (this was the missing piece!)
      'log "Installing AWS CLI"',
      'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"',
      'unzip awscliv2.zip',
      './aws/install',
      'rm -rf aws awscliv2.zip',
      
      // Install Python 3.12
      'log "Installing Python 3.12"',
      'add-apt-repository -y ppa:deadsnakes/ppa',
      'apt-get update -y',
      'apt-get install -y python3.12 python3.12-venv python3.12-dev python3-pip',
      
      // Install Node.js
      'log "Installing Node.js"',
      'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
      'apt-get install -y nodejs',
      
      // Install system dependencies
      'log "Installing system dependencies"',
      'apt-get install -y portaudio19-dev libasound2-dev libportaudio2 libportaudiocpp0',
      
      // Setup ubuntu user environment
      'log "Setting up ubuntu user environment"',
      'su - ubuntu -c "curl -LsSf https://astral.sh/uv/install.sh | sh"',
      'echo \'export PATH="/home/ubuntu/.local/bin:$PATH"\' >> /home/ubuntu/.bashrc',
      
      // Create project directory
      'log "Creating project directory"',
      'mkdir -p /home/ubuntu/demo_mcp_on_amazon_bedrock',
      'chown ubuntu:ubuntu /home/ubuntu/demo_mcp_on_amazon_bedrock',
      'cd /home/ubuntu/demo_mcp_on_amazon_bedrock',
      
      // Use git clone approach (more reliable than S3)
      'log "Cloning application code from GitHub"',
      'su - ubuntu -c "cd /home/ubuntu && git clone https://github.com/hcwongleo/demo-mcp-bedrock.git demo_mcp_on_amazon_bedrock"',
      'cd /home/ubuntu/demo_mcp_on_amazon_bedrock',
      
      // Override config with Nova Pro only
      'log "Configuring Nova Pro only model"',
      'cat > conf/config.json << EOL',
      '{',
      '\t"models": [',
      '\t\t{',
      '\t\t\t"model_id": "us.amazon.nova-pro-v1:0",',
      '\t\t\t"model_name": "Amazon Nova Pro v1"',
      '\t\t}',
      '\t],',
      '\t"mcpServers": {',
      '\t}',
      '}',
      'EOL',
      
      // Set proper ownership
      'chown -R ubuntu:ubuntu /home/ubuntu/demo_mcp_on_amazon_bedrock',
      'chmod 755 /home/ubuntu/demo_mcp_on_amazon_bedrock',
      
      // Create necessary directories
      'log "Creating necessary directories"',
      'mkdir -p logs tmp',
      'chown -R ubuntu:ubuntu logs tmp',
      
      // Remove Nova Sonic components if they exist
      'log "Removing Nova Sonic components"',
      'rm -f src/nova_sonic_manager.py src/websocket_manager.py || true',
      
      // Setup Python environment
      'log "Setting up Python environment"',
      'su - ubuntu -c "',
      'cd /home/ubuntu/demo_mcp_on_amazon_bedrock && \\',
      'export PATH=\"/home/ubuntu/.local/bin:$PATH\" && \\',
      'python3.12 -m venv .venv && \\',
      'source .venv/bin/activate && \\',
      'pip install --upgrade pip && \\',
      'pip install uv && \\',
      'uv sync --no-dev || pip install boto3 botocore fastapi uvicorn mcp openai aiohttp python-dotenv requests pandas pytz rx streamlit streamlit-cookies-controller streamlit-local-storage tzdata uvicorn websockets',
      '"',
      
      // Configure environment (using instance role only)
      'log "Configuring environment"',
      'cat > .env << EOL',
      'AWS_REGION=' + cdk.Stack.of(this).region,
      'LOG_DIR=./logs',
      'CHATBOT_SERVICE_PORT=8502',
      'MCP_SERVICE_HOST=127.0.0.1',
      'MCP_SERVICE_PORT=7002',
      'MCP_BASE_URL=http://127.0.0.1:7002',
      `API_KEY=${cdk.Names.uniqueId(this)}`,
      'EOL',
      'chown ubuntu:ubuntu .env',
      'chmod 600 .env',
      
      // Create startup script
      'log "Creating startup script"',
      'cat > start_services_simple.sh << EOL',
      '#!/bin/bash',
      'set -e',
      'cd /home/ubuntu/demo_mcp_on_amazon_bedrock',
      '',
      '# Source environment',
      'source .venv/bin/activate',
      'export $(grep -v "^#" .env | xargs)',
      'export PYTHONPATH=./src:$PYTHONPATH',
      '',
      '# Create log directories',
      'mkdir -p logs',
      '',
      '# Function to start MCP service',
      'start_mcp() {',
      '    echo "$(date): Starting MCP service"',
      '    python src/main.py \\',
      '        --mcp-conf conf/config.json \\',
      '        --user-conf conf/user_mcp_config.json \\',
      '        --host 127.0.0.1 \\',
      '        --port 7002 &',
      '    MCP_PID=$!',
      '    echo $MCP_PID > logs/mcp.pid',
      '    ',
      '    # Wait for MCP to be ready',
      '    for i in {1..30}; do',
      '        if curl -s http://127.0.0.1:7002/health > /dev/null 2>&1; then',
      '            echo "MCP service ready"',
      '            break',
      '        fi',
      '        sleep 2',
      '    done',
      '}',
      '',
      '# Function to start Streamlit',
      'start_streamlit() {',
      '    echo "$(date): Starting Streamlit service"',
      '    streamlit run chatbot.py \\',
      '        --server.port 8502 \\',
      '        --server.address 0.0.0.0 \\',
      '        --server.headless true &',
      '    STREAMLIT_PID=$!',
      '    echo $STREAMLIT_PID > logs/streamlit.pid',
      '}',
      '',
      '# Cleanup function',
      'cleanup() {',
      '    echo "Cleaning up processes..."',
      '    if [ -f logs/mcp.pid ]; then',
      '        kill $(cat logs/mcp.pid) 2>/dev/null || true',
      '    fi',
      '    if [ -f logs/streamlit.pid ]; then',
      '        kill $(cat logs/streamlit.pid) 2>/dev/null || true',
      '    fi',
      '    exit 0',
      '}',
      '',
      '# Set up signal handlers',
      'trap cleanup SIGTERM SIGINT',
      '',
      '# Start services',
      'start_mcp',
      'start_streamlit',
      '',
      '# Keep the script running',
      'echo "Services started, waiting..."',
      'wait',
      'EOL',
      
      'chmod +x start_services_simple.sh',
      'chown ubuntu:ubuntu start_services_simple.sh',
      
      // Create systemd service
      'log "Creating systemd service"',
      'cat > /etc/systemd/system/mcp-services.service << EOL',
      '[Unit]',
      'Description=MCP Services (Local Code)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=ubuntu',
      'Group=ubuntu',
      'Environment="HOME=/home/ubuntu"',
      'Environment="PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
      'WorkingDirectory=/home/ubuntu/demo_mcp_on_amazon_bedrock',
      'ExecStart=/bin/bash /home/ubuntu/demo_mcp_on_amazon_bedrock/start_services_simple.sh',
      'Restart=always',
      'RestartSec=10',
      'StandardOutput=journal',
      'StandardError=journal',
      'KillMode=mixed',
      'TimeoutStartSec=120',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOL',
      
      // Enable and start service
      'log "Enabling and starting services"',
      'systemctl daemon-reload',
      'systemctl enable mcp-services',
      'sleep 10',
      'systemctl start mcp-services',
      'sleep 15',
      'systemctl status mcp-services >> /var/log/mcp-deployment.log 2>&1 || true',
      'log "MCP deployment completed with local code"',
      
      // Create health check script
      'cat > /home/ubuntu/check_services.sh << EOL',
      '#!/bin/bash',
      'echo "=== Service Status ==="',
      'systemctl status mcp-services --no-pager',
      'echo "=== Process Status ==="',
      'ps aux | grep -E "(python|streamlit)" | grep -v grep',
      'echo "=== Port Status ==="',
      'ss -tlnp | grep -E "(7002|8502)"',
      'echo "=== Configuration ==="',
      'cat /home/ubuntu/demo_mcp_on_amazon_bedrock/conf/config.json',
      'echo "=== Recent Logs ==="',
      'tail -20 /home/ubuntu/demo_mcp_on_amazon_bedrock/logs/*.log 2>/dev/null || echo "No logs found"',
      'echo "=== Streamlit Health ==="',
      'curl -s http://localhost:8502 > /dev/null && echo "Streamlit responding" || echo "Streamlit not responding"',
      'EOL',
      'chmod +x /home/ubuntu/check_services.sh',
      'chown ubuntu:ubuntu /home/ubuntu/check_services.sh'
    );

    // Create Launch Template
    const launchTemplate = new ec2.LaunchTemplate(this, `${prefix}-LaunchTemplate`, {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
        { os: ec2.OperatingSystemType.LINUX }
      ),
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

    new cdk.CfnOutput(this, 'AllowedCIDR', {
      value: allowedCidr,
      description: 'CIDR block allowed to access the application'
    });

    new cdk.CfnOutput(this, 'DeploymentMethod', {
      value: 'Git Clone from GitHub (with AWS CLI pre-installed)',
      description: 'How the application code is deployed'
    });

    new cdk.CfnOutput(this, 'Authentication', {
      value: 'Uses EC2 Instance Role (no API keys needed)',
      description: 'Authentication method'
    });
  }
}
