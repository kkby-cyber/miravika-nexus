import * as React from 'react'

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Text,
} from '@react-email/components'
import * as brand from './brand'

interface SignupEmailProps {
  siteName: string
  siteUrl: string
  recipient: string
  confirmationUrl: string
}

export const SignupEmail = ({
  siteName,
  siteUrl,
  recipient,
  confirmationUrl,
}: SignupEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Confirm your email for {siteName}</Preview>
    <Body style={brand.main}>
      <Container style={brand.container}>
        <Text style={brand.brandMark}>MIRAVIKA</Text>
        <Text style={brand.brandTagline}>Luxury Redefined</Text>
        <Hr style={brand.divider} />
        <Heading style={brand.h1}>Confirm your email</Heading>
        <Text style={brand.text}>
          Thank you for joining{' '}
          <Link href={siteUrl} style={brand.link}>
            <strong>{siteName}</strong>
          </Link>
          .
        </Text>
        <Text style={brand.text}>
          Please confirm your email address (
          <Link href={`mailto:${recipient}`} style={brand.link}>
            {recipient}
          </Link>
          ) by selecting the button below:
        </Text>
        <Button style={brand.button} href={confirmationUrl}>
          Verify Email
        </Button>
        <Text style={brand.footer}>
          If you didn't create an account, you can safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default SignupEmail
