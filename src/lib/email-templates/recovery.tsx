import * as React from 'react'

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Text,
} from '@react-email/components'
import * as brand from './brand'

interface RecoveryEmailProps {
  siteName: string
  confirmationUrl: string
}

export const RecoveryEmail = ({
  siteName,
  confirmationUrl,
}: RecoveryEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Reset your password for {siteName}</Preview>
    <Body style={brand.main}>
      <Container style={brand.container}>
        <Text style={brand.brandMark}>MIRAVIKA</Text>
        <Text style={brand.brandTagline}>Luxury Redefined</Text>
        <Hr style={brand.divider} />
        <Heading style={brand.h1}>Reset your password</Heading>
        <Text style={brand.text}>
          We received a request to reset your password for {siteName}. Select
          the button below to choose a new password.
        </Text>
        <Button style={brand.button} href={confirmationUrl}>
          Reset Password
        </Button>
        <Text style={brand.footer}>
          If you didn't request a password reset, you can safely ignore this
          email. Your password will not be changed.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default RecoveryEmail
