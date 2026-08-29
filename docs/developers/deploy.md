# Build and deploy a CRM connector

Once you have developed your connector for a CRM, it is time to try it out. To do that, you will need to deploy your connector's server to a publicly accessible server


## Deploying server to AWS

Technically your connector's server could be deployed anywhere. You could host it yourself, or deploy it to a third-party like Heroku or AWS. To assist developers, we have provided a [serverless config file](https://www.serverless.com/) for AWS deployment under the `serverless-deploy`. 

1. Customize your environment
    
    ```bash
    cp serverless-deploy/sample.env.yml serverless-deploy/env.yml
    ```
	
	Then edit `env.yml`.

2. Customize your serverless deploy config
    
    ```bash
    cp serverless-deploy/sample.serverless.yml serverless-deploy/serverless.yml
    ```
	
	Then edit `serverless.yml`

3. Build and deploy the server

    ```bash
    pnpm build
    pnpm deploy
    ```
	
!!! tip "Deploying to another platform" 
    To deploy to another platform, run `pnpm build-local`. This creates a
    `build/` directory that can be packaged for another hosting provider.

### Server environment variables

| Variable                    | Description                                                         |
|-----------------------------|---------------------------------------------------------------------|
| `APP_SERVER`                | URL for your backend server                                         |
| `APP_SERVER_SECRET_KEY`     | Key to create secret toke between your server and client            |
| `TEST_CRM_CLIENT_ID`        | If CRM uses OAuth, it should be the client ID for OAuth             |
| `TEST_CRM_CLIENT_SECRET`    | If CRM uses OAuth, it should be the client secret for OAuth         |
| `TEST_CRM_ACCESS_TOKEN_URI` | If CRM uses OAuth, it should access token url for OAuth             |
| `TEST_CRM_REDIRECT_URI`     | You can use the default redirect URI, or change it to yours         |
| `DATABASE_URL`              | URL for your database, the default one is for local sqlite database |
