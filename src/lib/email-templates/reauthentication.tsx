import * as React from 'react'

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Text,
} from '@react-email/components'
import * as brand from './brand'

interface ReauthenticationEmailProps {
  token: string
}

export const ReauthenticationEmail = ({ token }: ReauthenticationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your MIRAVIKA verification code</Preview>
    <Body style={brand.main}>
      <Container style={brand.container}>
        <Text style={brand.brandMark}>MIRAVIKA</Text>
        <Text style={brand.brandTagline}>Luxury Redefined</Text>
        <Hr style={brand.divider} />
        <Heading style={brand.h1}>Confirm reauthentication</Heading>
        <Text style={brand.text}>Use the code below to confirm your identity:</Text>
        <Text style={brand.codeStyle}>{token}</Text>
        <Text style={brand.footer}>
          This code will expire shortly. If you didn't request it, you can
          safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default ReauthenticationEmail
